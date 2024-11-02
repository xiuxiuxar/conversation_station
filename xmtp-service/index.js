const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Client } = require('@xmtp/xmtp-js');
const { ethers } = require('ethers');
const WebSocket = require('ws');

const MAX_RETRIES = 3;
const RECONNECT_DELAY = 5000;
let isShuttingDown = false;

const LOG_TYPES = {
    INFO: 'info',
    WARNING: 'warning',
    ERROR: 'error'
};

function sendLog(type, message, data = {}) {
    wss.clients.forEach(client => {
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

// WebSocket Server Setup
const wss = new WebSocket.Server({ 
    host: process.env.HOST || '0.0.0.0', 
    port: 8080,
    clientTracking: true,
    pingInterval: 30000,
    pingTimeout: 5000
});
let connectedClients = {};
const conversationsMap = {};

// Connect to XMTP
async function connectToXMTP(privateKey, retryCount = 0) {
    try {
        const provider = new ethers.JsonRpcProvider(process.env.INFURA_URL);
        const wallet = new ethers.Wallet(privateKey).connect(provider);
        const publicAddress = wallet.address;

        sendLog(LOG_TYPES.INFO, 'Checking if address can message...');
        const canMessage = await Client.canMessage(publicAddress);
        if (!canMessage) {
            throw new Error(`${publicAddress} not enabled for XMTP`);
        }

        sendLog(LOG_TYPES.INFO, 'Creating XMTP client...');
        const xmtpClient = await Client.create(wallet, {
            env: 'dev',
            enableMessageCaching: true,
         });

        if (!xmtpClient) {
            throw new Error(`Failed to create XMTP client`);
        }

        sendLog(LOG_TYPES.INFO, `${publicAddress} connected to XMTP`);
        return { xmtpClient, publicAddress };
    } catch (error) {
        sendLog(LOG_TYPES.ERROR, 'XMTP connection details:', {
            error: error.message,
            stack: error.stack,
            cause: error.cause,
            attempt: retryCount + 1,
            maxRetries: MAX_RETRIES
        });

        if (retryCount < MAX_RETRIES) {
            sendLog(LOG_TYPES.INFO, `Retrying connection attempt ${retryCount + 1}/${MAX_RETRIES} in ${RECONNECT_DELAY}ms...`);
            await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY));
            return connectToXMTP(privateKey, retryCount + 1);
        }
        throw error;
    }
}

// Handle WebSocket Connections
wss.on('connection', async (ws) => {
    ws.isAlive = true;
    sendLog(LOG_TYPES.INFO, 'Client connected to WebSocket');

    ws.on('pong', () => {
        ws.isAlive = true;
        sendLog(LOG_TYPES.INFO, 'Received pong from client');
    });

    // Handle WebSocket messages
    ws.on('message', async (message) => {
        try {
            const msgData = JSON.parse(message);

            // Handle Subscription (Register on XMTP)
            if (msgData.type === 'subscribe') {
                const privateKey = msgData.privateKey;

                try {
                    const { xmtpClient, publicAddress } = await connectToXMTP(privateKey);
                    connectedClients[publicAddress] = { ws, xmtpClient };
                    sendLog(LOG_TYPES.INFO, `Agent ${publicAddress} subscribed.`);
                    ws.send(JSON.stringify({ status: 'subscribed', publicAddress }));
                    
                    // Start listening for messages immediately after subscription
                    startMessageListener(publicAddress);
                } catch (error) {
                    sendLog(LOG_TYPES.ERROR, 'Error connecting to XMTP:', {
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
                const senderData = connectedClients[fromAddress];

                if (senderData && senderData.xmtpClient) {
                    try {
                        // Check if a conversation already exists
                        let conversation;
                        if (conversationsMap[fromAddress] && conversationsMap[fromAddress][toAddress]) {
                            conversation = conversationsMap[fromAddress][toAddress];
                        } else {
                            // Open a new conversation
                            conversation = await senderData.xmtpClient.conversations.newConversation(toAddress);
                            if (!conversationsMap[fromAddress]) {
                                conversationsMap[fromAddress] = {};
                            }
                            conversationsMap[fromAddress][toAddress] = conversation;
                            sendLog(LOG_TYPES.INFO, `New conversation started between ${fromAddress} and ${conversation.peerAddress}`);
                        }

                        // Send the message through the conversation
                        const message = await conversation.send(content);
                        sendLog(LOG_TYPES.INFO, `Sending message from ${fromAddress} to ${toAddress}: ${message.content}`);
                    } catch (error) {
                        sendLog(LOG_TYPES.ERROR, 'Error sending message:', error);
                        ws.send(JSON.stringify({ status: 'error', message: 'Failed to send message.' }));
                    }
                } else {
                    ws.send(JSON.stringify({ status: 'error', message: 'Client not registered.' }));
                }
            }

            else {
                sendLog(LOG_TYPES.ERROR, 'Invalid message type:', msgData);
            }
        } catch (error) {
            sendLog(LOG_TYPES.ERROR, 'Error processing message:', error);
            ws.send(JSON.stringify({ status: 'error', message: 'Invalid message format.' }));
        }
    });

    // Handle WebSocket closing
    ws.on('close', () => {
        sendLog(LOG_TYPES.INFO, 'Client disconnected from WebSocket');
        for (const [address, clientData] of Object.entries(connectedClients)) {
            if (clientData.ws === ws) {
                if (activeStreams.has(address)) {
                    activeStreams.get(address).cancel();
                    activeStreams.delete(address);
                }
                delete connectedClients[address];
                sendLog(LOG_TYPES.INFO, `Removed ${address} from connected clients`);
                break;
            }
        }
    });
});

// Modify the message listening implementation
async function startMessageListener(publicAddress) {
    const clientData = connectedClients[publicAddress];
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

            sendLog(LOG_TYPES.INFO, `Processing message - From: ${sender}, To: ${recipient}, Content: ${message.content}`);

            if (recipient === publicAddress) {
                ws.send(JSON.stringify({
                    from: sender,
                    to: recipient,
                    content: message.content,
                }));
            }
        }
    } catch (error) {
        sendLog(LOG_TYPES.ERROR, 'Error in message listener:', error);
    }
}

process.on('SIGTERM', async () => {
    isShuttingDown = true;

    for (const stream of activeStreams.values()) {
        stream.cancel();
    }

    wss.clients.forEach(client => {
        client.close();
    });

    wss.close(() => {
        process.exit(0);
    });

});

// Add connection health check
const interval = setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) {
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);