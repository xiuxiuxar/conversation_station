const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Client } = require('@xmtp/xmtp-js');
const { ethers } = require('ethers');
const WebSocket = require('ws');

// Configuration
const CONFIG = {
    MAX_RETRIES: 3,
    RECONNECT_DELAY: 5000,
    WS_PORT: 8080,
    WS_HOST: process.env.HOST || '0.0.0.0',
    MAX_MESSAGE_SIZE: 1000000, // 1MB
    PING_INTERVAL: 30000,
    PING_TIMEOUT: 5000,
    NETWORK: process.env.NETWORK || 'dev',
};

const LOG_TYPES = {
    INFO: 'info',
    WARNING: 'warning',
    ERROR: 'error'
};

// Create a State Management class
class XMTPState {
    constructor() {
        this.isShuttingDown = false;
        this.activeStreams = new Map();
        this.connectedClients = {};
        this.conversationsMap = {};
    }
}

// Create a Logger class
class Logger {
    constructor(wss) {
        this.wss = wss;
    }

    send(type, message, data = {}) {
        this.wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                    type: 'log',
                    logType: type,
                    message,
                    data,
                    timestamp: new Date().toISOString()
                }));
            }
        });
    }
}

// Create an XMTP Service class
class XMTPService {
    constructor(state, logger) {
        this.state = state;
        this.logger = logger;
    }

    async connect(privateKey, retryCount = 0) {
        try {
            const provider = new ethers.JsonRpcProvider(process.env.INFURA_URL);
            const wallet = new ethers.Wallet(privateKey).connect(provider);
            const publicAddress = wallet.address;

            this.logger.send(LOG_TYPES.INFO, 'Checking if address can message...');
            const canMessage = await Client.canMessage(publicAddress);
            if (!canMessage) {
                throw new Error(`${publicAddress} not enabled for XMTP`);
            }

            this.logger.send(LOG_TYPES.INFO, 'Creating XMTP client...');
            const xmtpClient = await Client.create(wallet, {
                env: 'dev',
                enableMessageCaching: true,
             });

            if (!xmtpClient) {
                throw new Error(`Failed to create XMTP client`);
            }

            this.logger.send(LOG_TYPES.INFO, `${publicAddress} connected to XMTP`);
            return { xmtpClient, publicAddress };
        } catch (error) {
            this.logger.send(LOG_TYPES.ERROR, 'XMTP connection details:', {
                error: error.message,
                stack: error.stack,
                cause: error.cause,
                attempt: retryCount + 1,
                maxRetries: CONFIG.MAX_RETRIES
            });

            if (retryCount < CONFIG.MAX_RETRIES) {
                this.logger.send(LOG_TYPES.INFO, `Retrying connection attempt ${retryCount + 1}/${CONFIG.MAX_RETRIES} in ${CONFIG.RECONNECT_DELAY}ms...`);
                await new Promise(resolve => setTimeout(resolve, CONFIG.RECONNECT_DELAY));
                return this.connect(privateKey, retryCount + 1);
            }
            throw error;
        }
    }

    async startMessageListener(publicAddress) {
        const clientData = this.state.connectedClients[publicAddress];
        if (!clientData?.xmtpClient) return;

        const { ws, xmtpClient } = clientData;
        
        try {
            // Stream all messages
            const stream = await xmtpClient.conversations.streamAllMessages();
            
            // Process each message as it arrives
            for await (const message of stream) {
                const sender = message.senderAddress;
                const recipient = sender === publicAddress
                    ? message.conversation.peerAddress
                    : publicAddress;

                this.logger.send(LOG_TYPES.INFO, `Processing message - From: ${sender}, To: ${recipient}, Content: ${message.content}`);

                if (recipient === publicAddress) {
                    ws.send(JSON.stringify({
                        from: sender,
                        to: recipient,
                        content: message.content,
                    }));
                }
            }
        } catch (error) {
            this.logger.send(LOG_TYPES.ERROR, 'Error in message listener:', error);
        }
    }

    async sendMessage(fromAddress, toAddress, content) {
        const senderData = this.state.connectedClients[fromAddress];

        if (!senderData || !senderData.xmtpClient) {
            return { status: 'error', message: 'Client not registered.' };
        }

        try {
            // Check if a conversation already exists
            let conversation;
            if (this.state.conversationsMap[fromAddress] && this.state.conversationsMap[fromAddress][toAddress]) {
                conversation = this.state.conversationsMap[fromAddress][toAddress];
            } else {
                // Open a new conversation
                conversation = await senderData.xmtpClient.conversations.newConversation(toAddress);
                if (!this.state.conversationsMap[fromAddress]) {
                    this.state.conversationsMap[fromAddress] = {};
                }
                this.state.conversationsMap[fromAddress][toAddress] = conversation;
                this.logger.send(LOG_TYPES.INFO, `New conversation started between ${fromAddress} and ${conversation.peerAddress}`);
            }

            // Send the message through the conversation
            const message = await conversation.send(content);
            this.logger.send(LOG_TYPES.INFO, `Sending message from ${fromAddress} to ${toAddress}: ${message.content}`);
            return { status: 'success' };
        } catch (error) {
            this.logger.send(LOG_TYPES.ERROR, 'Error sending message:', error);
            return { status: 'error', message: 'Failed to send message.' };
        }
    }
}

// Create a WebSocket Handler class
class WebSocketHandler {
    constructor(state, xmtpService, logger) {
        this.state = state;
        this.xmtpService = xmtpService;
        this.logger = logger;
    }

    async handleMessage(ws, message) {
        // Close the connection if the message is too large
        if (message.length > CONFIG.MAX_MESSAGE_SIZE) { // 1MB
            ws.close(1009, 'Message too large');
            return;
        }

        try {
            const msgData = JSON.parse(message);

            // Handle Subscription (Register on XMTP)
            if (msgData.type === 'subscribe') {
                const privateKey = msgData.privateKey;

                try {
                    const { xmtpClient, publicAddress } = await this.xmtpService.connect(privateKey);
                    this.state.connectedClients[publicAddress] = { ws, xmtpClient };
                    this.logger.send(LOG_TYPES.INFO, `Agent ${publicAddress} subscribed.`);
                    ws.send(JSON.stringify({ status: 'subscribed', publicAddress }));
                    
                    // Start listening for messages immediately after subscription
                    await this.xmtpService.startMessageListener(publicAddress);
                } catch (error) {
                    this.logger.send(LOG_TYPES.ERROR, 'Error connecting to XMTP:', {
                        error: error.message,
                        stack: error.stack,
                        cause: error.cause,
                    });
                    ws.send(JSON.stringify({ status: 'error', message: 'Failed to subscribe to XMTP.' }));
                }
            }

            // Handle sending a message
            else if (msgData.type === 'send_message') {
                const toAddress = msgData.to;
                const fromAddress = msgData.from;
                const content = msgData.content;

                const result = await this.xmtpService.sendMessage(fromAddress, toAddress, content);
                ws.send(JSON.stringify(result || { status: 'success' }));
            }

            else {
                this.logger.send(LOG_TYPES.ERROR, 'Invalid message type:', msgData);
            }
        } catch (error) {
            this.logger.send(LOG_TYPES.ERROR, 'Error processing message:', error);
            ws.send(JSON.stringify({ status: 'error', message: 'Invalid message format.' }));
        }
    }

    handleClose(ws) {
        this.logger.send(LOG_TYPES.INFO, 'Client disconnected from WebSocket');
        for (const [address, clientData] of Object.entries(this.state.connectedClients)) {
            if (clientData.ws === ws) {
                if (this.state.activeStreams.has(address)) {
                    this.state.activeStreams.get(address).cancel();
                    this.state.activeStreams.delete(address);
                }
                delete this.state.connectedClients[address];
                this.logger.send(LOG_TYPES.INFO, `Removed ${address} from connected clients`);
                break;
            }
        }
    }
}

// Main application setup
function setupWebSocketServer() {
    const state = new XMTPState();
    
    const wss = new WebSocket.Server({ 
        host: CONFIG.WS_HOST, 
        port: CONFIG.WS_PORT,
        clientTracking: true,
        pingInterval: CONFIG.PING_INTERVAL,
        pingTimeout: CONFIG.PING_TIMEOUT
    });

    const logger = new Logger(wss);
    const xmtpService = new XMTPService(state, logger);
    const wsHandler = new WebSocketHandler(state, xmtpService, logger);

    // WebSocket connection handling
    wss.on('connection', async (ws) => {
        ws.isAlive = true;
        logger.send(LOG_TYPES.INFO, 'Client connected to WebSocket');

        ws.on('pong', () => {
            ws.isAlive = true;
            logger.send(LOG_TYPES.INFO, 'Received pong from client');
        });

        ws.on('message', async (message) => wsHandler.handleMessage(ws, message));
        ws.on('close', () => wsHandler.handleClose(ws));
    });

    return { wss, state };
}

// Application startup
const { wss, state } = setupWebSocketServer();

// Cleanup handlers
process.on('SIGTERM' || 'SIGINT', async () => {
    state.isShuttingDown = true;
    
    for (const stream of state.activeStreams.values()) {
        stream.cancel();
    }

    wss.clients.forEach(client => client.close());
    wss.close(() => process.exit(0));
});

// Health check
const interval = setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, CONFIG.PING_INTERVAL);