/*
    Frequency Mute v1.0.0 by AAD
    https://github.com/AmateurAudioDude/
*/

'use strict';

(() => {

const pluginName = "Frequency Mute";

const ALTERNATIVE_POSITION = true;

// Variables
let wsSocket;
let currentStatus = 'normal'; // 'normal', 'muted', or 'attenuated'
let statusNotification = null;
let originalFreqColor = '';

// Get WebSocket URL
const currentURL = new URL(window.location.href);
const WebserverURL = currentURL.hostname;
const WebserverPath = currentURL.pathname.replace(/setup/g, '');
const WebserverPORT = currentURL.port || (currentURL.protocol === 'https:' ? '443' : '80');
const protocol = currentURL.protocol === 'https:' ? 'wss:' : 'ws:';
const WebsocketURL = `${protocol}//${WebserverURL}:${WebserverPORT}${WebserverPath}data_plugins`;

// Get original colour of #data-frequency
function getOriginalColor() {
    const freqElement = document.getElementById('data-frequency');
    if (freqElement && !originalFreqColor) {
        originalFreqColor = window.getComputedStyle(freqElement).color;
    }
}

// Create status notification element
function createStatusNotification() {
    if (statusNotification) return;

    const freqContainer = document.getElementById('freq-container');
    if (!freqContainer) return;

    // Value for top based on screen orientation and size
    const displayOffset = ALTERNATIVE_POSITION ? -42 : 0;
    const isMobilePortrait = window.matchMedia("(orientation: portrait) and (max-width: 768px)").matches;
    const topValue = isMobilePortrait ? '10px' : 42 + displayOffset + 'px';

    statusNotification = document.createElement('div');
    statusNotification.id = 'frequency-status-notification';
    statusNotification.style.cssText = `
        position: absolute;
        top: ${topValue};
        left: 50%;
        transform: translateX(-50%);
        font-size: 12px;
        font-weight: 600;
        color: #ff4444;
        background-color: rgba(255, 68, 68, 0.15);
        padding: 0 8px;
        border-radius: 4px;
        opacity: 0;
        transition: opacity 0.3s ease;
        pointer-events: none;
        white-space: nowrap;
    `;

    // Ensure freq-container is positioned properly
    if (window.getComputedStyle(freqContainer).position === 'static') freqContainer.style.position = 'relative';

    freqContainer.appendChild(statusNotification);
}

// Update UI based on status
function updateStatusUI(status) {
    const freqElement = document.getElementById('data-frequency');
    if (!freqElement) return;

    if (!originalFreqColor) {
        getOriginalColor();
    }

    if (!statusNotification) {
        createStatusNotification();
    }

    if (status === 'muted') {
        // Muted
        freqElement.style.color = '#ee3333';
        if (statusNotification) {
            statusNotification.textContent = 'MUTED';
            statusNotification.style.color = '#ff4444';
            statusNotification.style.backgroundColor = 'rgba(255, 68, 68, 0.01)';
            statusNotification.style.opacity = '0.99';
        }
    } else if (['attenuated', 'attenuated_s', 'attenuated_d'].includes(status)) {
        // Attenuated
        const opacityMap = {
            attenuated: 0.6,
            attenuated_s: 0.7,
            attenuated_d: 0.8
        };

        freqElement.style.color = originalFreqColor || '';

        if (statusNotification) {
            statusNotification.textContent = 'ATTENUATED';
            statusNotification.style.color = '#ffaa00';
            statusNotification.style.backgroundColor = 'rgba(255, 170, 0, 0.01)';
            statusNotification.style.opacity = opacityMap[status];
        }
    } else {
        // Normal
        freqElement.style.color = originalFreqColor || '';
        if (statusNotification) {
            statusNotification.style.opacity = '0';
        }
    }

    currentStatus = status;
}

// WebSocket connection
async function setupWebSocket() {
    if (!wsSocket || wsSocket.readyState === WebSocket.CLOSED) {
        try {
            wsSocket = new WebSocket(WebsocketURL);

            wsSocket.onopen = () => {
                console.log(`[${pluginName}] Connected to WebSocket`);

                // Request current mute status from server
                wsSocket.send(JSON.stringify({
                    type: 'frequency-mute-request-status'
                }));
            };

            wsSocket.onmessage = function(event) {
                try {
                    const data = JSON.parse(event.data);

                    if (data.type === 'frequency-mute' && data.value) {
                        updateStatusUI(data.value.status);
                    }
                } catch (error) {
                    console.error(`[${pluginName}] Error parsing message:`, error);
                }
            };

            wsSocket.onerror = (error) => {
                console.error(`[${pluginName}] WebSocket error:`, error);
            };

            wsSocket.onclose = () => {
                console.log(`[${pluginName}] WebSocket closed, reconnecting...`);
                setTimeout(setupWebSocket, 5000);
            };
        } catch (error) {
            console.error(`[${pluginName}] Failed to setup WebSocket:`, error);
            setTimeout(setupWebSocket, 5000);
        }
    }
}

// Initialise when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        getOriginalColor();
        createStatusNotification();
        setupWebSocket();
    });
} else {
    getOriginalColor();
    createStatusNotification();
    setupWebSocket();
}

})();
