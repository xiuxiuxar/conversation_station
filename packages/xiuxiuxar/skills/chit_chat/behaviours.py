# -*- coding: utf-8 -*-
# ------------------------------------------------------------------------------
#
#   Copyright 2024 xiuxiuxar
#
#   Licensed under the Apache License, Version 2.0 (the "License");
#   you may not use this file except in compliance with the License.
#   You may obtain a copy of the License at
#
#       http://www.apache.org/licenses/LICENSE-2.0
#
#   Unless required by applicable law or agreed to in writing, software
#   distributed under the License is distributed on an "AS IS" BASIS,
#   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
#   See the License for the specific language governing permissions and
#   limitations under the License.
#
# ------------------------------------------------------------------------------

"""This package contains a chat behaviour."""

import os
import asyncio
import openai
import json
import time
from pathlib import Path
from itertools import cycle
from typing import cast
import subprocess
import websockets
from dotenv import load_dotenv
from eth_account import Account

from aea.skills.behaviours import Behaviour, TickerBehaviour

from packages.xiuxiuxar.skills.chit_chat.data_models import (
    Message,
    Messages,
)

WEBSOCKET_URI = "ws://localhost:8080"

MODEL = "Meta-Llama-3-1-405B-Instruct-FP8"
BASE_URL = "https://chatapi.akash.network/api/v1"


def get_repo_root() -> Path:
    """Get the root directory of the repository."""
    command = ['git', 'rev-parse', '--show-toplevel']
    repo_root = subprocess.check_output(command, stderr=subprocess.STDOUT).strip()
    return Path(repo_root.decode('utf-8'))


# Load environment variables from .env file
load_dotenv(get_repo_root() / ".env")


def derive_public_address(private_key):
    """Derive the public address from a private key."""
    account = Account.from_key(private_key)
    return account.address


def answer(llm_client, user_prompt: str, context_data: str) -> str:
    """Answer a user prompt using the LLM client."""
    max_tokens = 300

    system = Message(
        role="system",
        content=(
            f"""
            You are an Autonomous Economic Agent designed to assist users in understanding
                your capabilities and functionalities.
            Your task is to provide clear and informative responses to user inquiries about your:
            - design
            - operations
            - services
            You have access to:
            - this source code: https://github.com/xiuxiuxar/conversation_station
            - all loaded variables
            Always respond from the perspective of the agent, maintaining a tone that is helpful and approachable.
            Provide specific examples when possible to:
            - illustrate your points
            - keep your answers concise and relevant.
            Your responses should be limited to {max_tokens} tokens.
            If you're unsure about a specific question, provide the best possible answer based on your knowledge.
            Here's the current context data: {context_data}
            Available actions: 
            1. update_tick_interval: Changes the ChitChatBehaviour tick interval
            2. get_info: Retrieves information about the agent
            ALWAYS AND ONLY respond with a JSON object containing: 
                - "action": The action to take (or "none" if no action needed)
                - "params": Parameters for the action (if applicable)
                - "response": Your verbal response to the user
            Example: 
            {{
                "action": "update_tick_interval", 
                "params": {{"new_interval": 10}}, 
                "response": "I have updated the ChitChatBehaviour tick interval to 10 seconds."
            }}
            """
        ),
    )

    user = Message(
        role="user",
        content=user_prompt,
    )

    messages = Messages(messages=[system, user])

    llm_response = llm_client.chat.completions.create(
        model=MODEL,
        **messages.model_dump(),
        n=1,                      # number of llm_response.choices to return
        max_tokens=max_tokens,    # limit response size
        temperature=0.7,          # higher temperature == more variability
    )

    return llm_response.choices[0].message.content


def safe_repr(key, value):
    """Redact sensitive keys from the value."""
    sensitive_keys = ['key', 'token', 'secret', 'password', 'api']
    if isinstance(value, str) and (any(k in key.lower() for k in sensitive_keys) or 
                                    any(k in value.lower() for k in sensitive_keys)):
        return '[REDACTED]'
    elif isinstance(value, dict):
        return {k: safe_repr(k, v) for k, v in value.items()}
    elif isinstance(value, list):
        return [safe_repr(str(i), v) for i, v in enumerate(value)]
    return repr(value)


class WebSocketManager:
    """WebSocketManager."""

    def __init__(self, uri: str, logger):
        self.uri = uri
        self.websocket = None
        self.logger = logger
        self.connected = False
        self.reconnect_interval = 5  # seconds
        self._running = False
        self._handlers = []

    def add_message_handler(self, handler):
        """Add a message handler."""
        self._handlers.append(handler)

    async def connect(self):
        """Connect to the WebSocket server."""
        self._running = True
        while self._running:
            try:
                if not self.connected:
                    self.websocket = await websockets.connect(self.uri)
                    self.connected = True
                    self.logger.info(f"Connected to WebSocket at {self.uri}")
                    await self._handle_messages()
            except Exception as e:
                self.logger.error(f"WebSocket connection error: {e}")
                self.connected = False
                await asyncio.sleep(self.reconnect_interval)

    async def _handle_messages(self):
        try:
            while self.connected and self._running:
                message = await self.websocket.recv()
                message_data = json.loads(message)

                if message_data.get("type") == "log":
                    log_type = message_data.get('logType', 'info')
                    log_msg = message_data.get('message', '')
                    log_data = message_data.get('data', {})

                    if log_type == "error":
                        self.logger.error(f"XMTP: {log_msg}", extra=log_data)
                    elif log_type == "warning":
                        self.logger.warning(f"XMTP: {log_msg}", extra=log_data)
                    else:
                        self.logger.info(f"XMTP: {log_msg}", extra=log_data)
                    continue

                for handler in self._handlers:
                    await handler(message)
        except Exception as e:
            self.logger.error(f"Error handling messages: {e}")
            self.connected = False

    async def send(self, data: dict):
        """Send a message to the WebSocket server."""
        if not self.connected:
            self.logger.error("Cannot send message: WebSocket not connected")
            return
        
        try:
            await self.websocket.send(json.dumps(data))
            self.logger.info(f"Sent message: {data}")
        except Exception as e:
            self.logger.error(f"Error sending message: {e}")
            self.connected = False

    async def close(self):
        """Close the WebSocket connection."""
        self._running = False
        if self.websocket:
            await self.websocket.close()


class ChitChatBehaviour(TickerBehaviour):
    """ChitChatBehaviour."""

    def __init__(self, **kwargs):
        tick_interval = cast(int, kwargs.pop("tick_interval"))
        super().__init__(tick_interval=tick_interval, **kwargs)

    def setup(self) -> None:
        """Implement the setup."""
        self.context.logger.info(f"Setup {self.__class__.__name__}")
        self.context.logger.info(f"Tick interval: {self.tick_interval}")

        self.xmtp_service_dir = get_repo_root() / "xmtp-service"
        self.xmtp_server_process = None
        self.start_xmtp_server()

        time.sleep(2)
        # subscribe agent to XMTP server
        agent_pk = os.environ.get("AGENT_PK")
        assert agent_pk is not None
        self.agent_address = derive_public_address(agent_pk)
        self.ws_manager = WebSocketManager(WEBSOCKET_URI, self.context.logger)
        self.ws_manager.add_message_handler(self.handle_message)
        
        self.ws_connect_task = asyncio.create_task(self.ws_manager.connect())
        self.subscribe_agent_task = asyncio.create_task(self.subscribe_agent(agent_pk))

        self.llm_client = openai.OpenAI(
            api_key=self.context.params.akash_api_key,
            base_url=BASE_URL,
        )

    def start_xmtp_server(self):
        """Start the XMTP server on port 8080."""
        if self.xmtp_server_process is None or self.xmtp_server_process.poll() is not None:
            try:
                command = ["node", "index.js"]
                self.xmtp_server_process = subprocess.Popen(command, cwd=self.xmtp_service_dir)
                self.context.logger.info("XMTP server started on port 8080.")
            except Exception as e:
                self.context.logger.error(f"Error starting XMTP server: {e}")

    async def subscribe_agent(self, agent_pk: str):
        """Subscribe the agent to the WebSocket server."""
        await asyncio.sleep(1)  # Give WebSocket time to connect
        data = {"type": "subscribe", "privateKey": agent_pk}
        await self.ws_manager.send(data)

    async def handle_message(self, message):
        """Handle a message from the WebSocket server."""
        message_data = json.loads(message)
        self.context.logger.info(f"Agent received: {message_data}")
        
        if "content" in message_data:
            user_prompt = message_data["content"]
            context_data = self.get_context_data()
            llm_response = answer(self.llm_client, user_prompt, context_data=context_data)
            action_data = json.loads(llm_response)
            self.execute_action(action_data)
            
            echo_data = {
                "type": "send_message",
                "to": message_data["from"],
                "from": self.agent_address,
                "content": action_data['response'],
            }
            await self.ws_manager.send(echo_data)

    def get_context_data(self) -> str:
        """Get the context data."""
        context_data = {
            "params": {
                attr: safe_repr(attr, getattr(self.context.params, attr))
                for attr in dir(self.context.params)
                if not attr.startswith('_')
            },
            "context": {
                attr: safe_repr(attr, getattr(self.context, attr))
                for attr in dir(self.context)
                if not attr.startswith('_')
            },
            "config": safe_repr('config', self.context.params.config),
            "configuration": {
                "class_name": self.context.params.configuration.class_name,
                "args": safe_repr('args', self.context.params.configuration.args),
            },
            "tick_interval": self.tick_interval,
            "repo_url": "https://github.com/xiuxiuxar/conversation_station"
        }

        context_str = "\n".join(f"{k}: {v}" for k, v in context_data.items())
        return context_str

    async def handler_requests(self, websocket):
        """Handle incoming WebSocket messages and respond accordingly."""

        try:
            while True:
                message = await websocket.recv()
                message_data = json.loads(message)
                self.context.logger.info(f"Agent received: {message_data}")
                user_prompt = message_data.get("content")
                context_data = self.get_context_data()
                llm_response = answer(self.llm_client, user_prompt, context_data=context_data)
                action_data = json.loads(llm_response)
                self.execute_action(action_data)
                self.context.logger.info(f"User: {user_prompt}\nAI: {action_data['response']}")
                self.context.logger.info(f"Tick interval: {self.tick_interval}")

                # if ():
                echo_data = {
                    "type": "send_message",
                    "to": message_data["from"],
                    "from": self.agent_address,
                    "content": action_data['response'],
                }
                await websocket.send(json.dumps(echo_data))
                self.context.logger.info(f"Agent echoed: {message_data['content']}")
                await asyncio.sleep(10)
        except websockets.exceptions.ConnectionClosed as e:
            self.context.logger.error(f"WebSocket connection closed unexpectedly: {e}")
        except Exception as e:
            self.context.logger.error(f"Error in handling requests: {e}")

    def check_server_health(self) -> None:
        """Check if XMTP server is running and restart if necessary."""
        if self.xmtp_server_process is None or self.xmtp_server_process.poll() is not None:
            self.context.logger.warning("XMTP server down. Restarting...")
            self.start_xmtp_server()

    def act(self) -> None:
        """Implement the act."""

        self.check_server_health()
        
    def execute_action(self, action_data: dict):
        """Execute an action."""
        action = action_data.get('action', 'none')
        params = action_data.get('params', {})

        if action == "update_tick_interval":
            new_interval = params.get("new_interval")
            if new_interval is not None:
                self.update_tick_interval(new_interval)
        else:
            pass

    def update_tick_interval(self, new_interval: int) -> None:
        """Update the tick interval."""
        self._tick_interval = new_interval
        self.context.params.tick_interval = new_interval

    def teardown(self) -> None:
        """Clean up resources."""
        if hasattr(self, 'ws_manager'):
            self.cleanup_task = asyncio.create_task(self.ws_manager.close())

        if self.xmtp_server_process and self.xmtp_server_process.poll() is None:
            self.context.logger.info("Terminating XMTP server.")
            self.xmtp_server_process.terminate()
            self.xmtp_server_process.wait()
        