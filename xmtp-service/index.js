const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Client } = require('@xmtp/xmtp-js');
const { ethers } = require('ethers');
const WebSocket = require('ws');

// WebSocket Server Setup
const wss = new WebSocket.Server({ host: process.env.HOST || '0.0.0.0', port: 8080 });
let connectedClients = {};
const conversationsMap = {};

// Connect to XMTP
async function connectToXMTP(privateKey) {
    try {
        const provider = new ethers.JsonRpcProvider(process.env.INFURA_URL);
        const wallet = new ethers.Wallet(privateKey).connect(provider);
        const publicAddress = wallet.address;

        console.log('Checking if address can message...');
        const canMessage = await Client.canMessage(publicAddress);
        if (!canMessage) {
            throw new Error(`${publicAddress} not enabled for XMTP`);
        }

        console.log('Creating XMTP client...');
        const xmtpClient = await Client.create(wallet, { env: 'dev' });

        if (!xmtpClient) {
            throw new Error(`Failed to create XMTP client`);
        }

        console.log(`${publicAddress} connected to XMTP`);
        return { xmtpClient, publicAddress };
    } catch (error) {
        console.error('XMTP connection details:', {
            error: error.message,
            stack: error.stack,
            cause: error.cause,
        });
        throw error;
    }
}

// Handle WebSocket Connections
wss.on('connection', async (ws) => {
    console.log('Client connected to WebSocket');

    ws.on('message', async (message) => {
        const msgData = JSON.parse(message);

        // Handle Subscription (Register on XMTP)
        if (msgData.type === 'subscribe') {
            const privateKey = msgData.privateKey;

            try {
                const { xmtpClient, publicAddress } = await connectToXMTP(privateKey);
                connectedClients[publicAddress] = { ws, xmtpClient };
                console.log(`Agent ${publicAddress} subscribed.`);
                ws.send(JSON.stringify({ status: 'subscribed', publicAddress }));
                
                // Start listening for messages immediately after subscription
                startMessageListener(publicAddress);
            } catch (error) {
                console.error('Error connecting to XMTP:', error);
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
                        console.log(`New conversation started between ${fromAddress} and ${conversation.peerAddress}`)
                    }

                    // Send the message through the conversation
                    const message = await conversation.send(content);
                    console.log(`Sending message from ${fromAddress} to ${toAddress}: ${message.content}`);
                } catch (error) {
                    console.error('Error sending message:', error);
                    ws.send(JSON.stringify({ status: 'error', message: 'Failed to send message.' }));
                }
            } else {
                ws.send(JSON.stringify({ status: 'error', message: 'Client not registered.' }));
            }
        }

        else {
            console.error('Invalid message type:', msgData);
        }
    });

    // Handle WebSocket closing
    ws.on('close', () => {
        console.log('Client disconnected from WebSocket');
        // Clean up connectedClients object
        for (const [address, clientData] of Object.entries(connectedClients)) {
            if (clientData.ws === ws) {
                delete connectedClients[address];
                console.log(`Removed ${address} from connected clients`);
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

            console.log(`Processing message - From: ${sender}, To: ${recipient}, Content: ${message.content}`);

            if (recipient === publicAddress) {
                ws.send(JSON.stringify({
                    from: sender,
                    to: recipient,
                    content: message.content,
                }));
            }
        }
    } catch (error) {
        console.error('Error in message listener:', error);
    }
}
