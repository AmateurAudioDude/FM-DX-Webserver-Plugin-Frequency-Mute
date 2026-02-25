/*
    Frequency Mute v1.0.0 by AAD
    https://github.com/AmateurAudioDude/

    //// Server-side code ////
*/

'use strict';

const pluginName = "Frequency Mute";

// Library imports
const express = require('express');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// File imports
const config = require('./../../config.json');
const { logInfo, logWarn, logError } = require('../../server/console');
const datahandlerReceived = require('../../server/datahandler');

// Define paths
const rootDir = path.dirname(require.main.filename);
const configFolderPath = path.join(rootDir, 'plugins_configs');
const configFilePath = path.join(configFolderPath, 'FrequencyMute.json');

// const variables
const startupVolume = config.audio.startupVolume;
const webserverPort = config.webserver.webserverPort || 8080;
const externalWsUrl = `ws://127.0.0.1:${webserverPort}`;

// let variables
let textSocket, textSocketLost, extraSocket, debounceTimer;
let currentFrequency = 0;
let currentFrequencyRounded = 0;
let previousFrequencyRounded = 0;
let mutedFrequencies = [];
let freqTolerance = 0.05;
let limitManualBandwidth = false;
let maxManualBandwidth = 151;
let bandwidthInterceptValue = 'W';
let disablePlugin = false;
let currentStatus = 'normal'; // 'normal', 'muted', or 'attenuated'
let isMuted = false;

// Check if FrequencyMute.json exists
function checkConfigFile() {
    if (!fs.existsSync(configFolderPath)) {
        logInfo(`${pluginName}: Creating plugins_configs folder...`);
        fs.mkdirSync(configFolderPath, { recursive: true });
    }

    if (!fs.existsSync(configFilePath)) {
        logInfo(`${pluginName}: Creating default FrequencyMute.json...`);
        const defaultConfig = {
            "frequencies": [
                88.0,
                {"freq": 88.1, "mode": "A"},
                {"freq": 88.2, "mode": "S"},
                {"freq": 88.3, "mode": "D"}
            ],
            "tolerance": 0.05,
            "limitManualBandwidth": false,
            "maxManualBandwidth": 151,
            "bandwidthInterceptValue": "W",
            "disablePlugin": false
        };

        // Custom formatting to keep frequency objects on one line
        const formattedJson = JSON.stringify(defaultConfig, null, 4)
            .replace(/\{\s+"freq":\s+([^,]+),\s+"mode":\s+"([^"]+)"\s+\}/g, '{"freq": $1, "mode": "$2"}');

        fs.writeFileSync(configFilePath, formattedJson);
    }
}

// Default settings
const defaultSettings = {
    frequencies: [],
    tolerance: 0.05,
    limitManualBandwidth: false,
    maxManualBandwidth: 151,
    bandwidthInterceptValue: 'W',
    disablePlugin: false
};

// Load FrequencyMute.json
function loadMutedFrequencies(isReloaded = false) {
    try {
        const rawData = fs.readFileSync(configFilePath, 'utf8');
        const configData = JSON.parse(rawData);

        // Check for missing settings and add defaults
        let configModified = false;
        for (const key in defaultSettings) {
            if (!(key in configData)) {
                configData[key] = defaultSettings[key];
                configModified = true;
                logInfo(`${pluginName}: Added missing setting '${key}' with default value`);
            }
        }

        // Save updated config if any settings were added
        if (configModified) {
            const formattedJson = JSON.stringify(configData, null, 4)
                .replace(/\{\s+"freq":\s+([^,]+),\s+"mode":\s+"([^"]+)"\s+\}/g, '{"freq": $1, "mode": "$2"}');
            fs.writeFileSync(configFilePath, formattedJson);
        }

        const rawFrequencies = configData.frequencies || [];
        freqTolerance = configData.tolerance || 0.05;
        limitManualBandwidth = configData.limitManualBandwidth || false;
        maxManualBandwidth = configData.maxManualBandwidth || 151;
        bandwidthInterceptValue = configData.bandwidthInterceptValue || 'W';
        disablePlugin = configData.disablePlugin || false;

        // Parse frequencies
        // Modes: M = mute, A = attenuate level 1, S = attenuate level 2, D = attenuate level 3
        const validModes = ['M', 'A', 'S', 'D'];
        mutedFrequencies = rawFrequencies.map(item => {
            if (typeof item === 'number') {
                // Mute by default
                return { freq: item, mode: 'M' };
            } else if (typeof item === 'object' && item.freq !== undefined) {
                const mode = item.mode ? item.mode.toUpperCase() : 'M';
                return {
                    freq: item.freq,
                    mode: validModes.includes(mode) ? mode : 'M'
                };
            }
            return null;
        }).filter(item => item !== null);

        const mutedCount = mutedFrequencies.filter(f => f.mode === 'M').length;
        const attenuatedCount = mutedFrequencies.filter(f => f.mode === 'A').length + mutedFrequencies.filter(f => f.mode === 'S').length + mutedFrequencies.filter(f => f.mode === 'D').length;
        logInfo(`${pluginName}: ${isReloaded ? 'Reloaded' : 'Loaded'} ${mutedCount} muted, ${attenuatedCount} attenuated frequencies (tolerance: \u00B1${freqTolerance} MHz)`);

        // Check current frequency against new list on reload
        if (isReloaded && currentFrequencyRounded > 0) {
            recheckCurrentFrequency();
        }
    } catch (err) {
        logError(`${pluginName}: Failed to parse FrequencyMute.json:`, err.message);
        mutedFrequencies = [];
        freqTolerance = 0.05;
    }
}

// Monitor file changes
function watchFile() {
    let filePreviouslyExisted = fs.existsSync(configFilePath);

    fs.watch(configFolderPath, (eventType, filename) => {
        if (filename !== path.basename(configFilePath)) return;

        const fileNowExists = fs.existsSync(configFilePath);

        if (!filePreviouslyExisted && fileNowExists) {
            logInfo(`${pluginName}: FrequencyMute.json created`);
            filePreviouslyExisted = true;
            loadMutedFrequencies(true);
            return;
        }

        if (filePreviouslyExisted && !fileNowExists) {
            logInfo(`${pluginName}: FrequencyMute.json deleted`);
            filePreviouslyExisted = false;
            mutedFrequencies = [];
            return;
        }

        if (fileNowExists) {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                loadMutedFrequencies(true);
            }, 500);
        }
    });
}

// Send status to client
function sendToClient(status, forceUpdate) {
    if ((!disablePlugin || forceUpdate) && (extraSocket && extraSocket.readyState === WebSocket.OPEN)) {
        extraSocket.send(JSON.stringify({
            type: 'frequency-mute',
            value: {
                status: status, // 'normal', 'muted', or 'attenuated'
                frequency: currentFrequencyRounded
            }
        }));
    }
}

// Helper function to get status from mode
function getStatusFromMode(mode) {
    switch (mode) {
        case 'A': return 'attenuated';
        case 'S': return 'attenuated_s';
        case 'D': return 'attenuated_d';
        case 'M': return 'muted';
        default: return 'muted';
    }
}

// Recheck current frequency
function recheckCurrentFrequency() {
    if (disablePlugin) {
        applyVolumeChange('normal', true);
        sendToClient('normal', true);

        return;
    }

    let newStatus = 'normal';
    let matchedMode = null;

    // Consider floating point precision
    const epsilon = 0.001;

    for (const freqItem of mutedFrequencies) {
        if (Math.abs(currentFrequencyRounded - freqItem.freq) <= (freqTolerance + epsilon)) {
            matchedMode = freqItem.mode;
            newStatus = getStatusFromMode(matchedMode);
            break;
        }
    }

    // Update state if it changed
    currentStatus = newStatus;
    applyVolumeChange(newStatus);
    sendToClient(newStatus);
}

// Apply volume change based on status
function applyVolumeChange(status, forceUpdate) {
    if (disablePlugin && !forceUpdate) return;
    if (status === 'muted') {
        // Mute
        sendCommandToClient('Y' + (0) + '\n');
        isMuted = true;
    } else if (status === 'attenuated') {
        // Attenuate (A)
        sendCommandToClient('Y' + ((startupVolume / 1.1) * 100).toFixed(0) + '\n');
    } else if (status === 'attenuated_s') {
        // Attenuate (S)
        sendCommandToClient('Y' + ((startupVolume / 1.15) * 100).toFixed(0) + '\n');
    } else if (status === 'attenuated_d') {
        // Attenuate (D)
        sendCommandToClient('Y' + ((startupVolume / 1.2) * 100).toFixed(0) + '\n');
    } else {
        // Normal
        sendCommandToClient('Y' + (startupVolume * 100).toFixed(0) + '\n', forceUpdate);
        isMuted = false;
    }
}

// Serialport status variables
let alreadyWarnedMissingSerialportVars = false;
let getSerialportStatus = null;

(function initSerialportStatusSource() {
  if (
    datahandlerReceived?.state &&
    typeof datahandlerReceived.state.isSerialportAlive !== 'undefined' &&
    typeof datahandlerReceived.state.isSerialportRetrying !== 'undefined'
  ) {
    getSerialportStatus = () => ({
      isAlive: datahandlerReceived.state.isSerialportAlive,
      isRetrying: datahandlerReceived.state.isSerialportRetrying
    });
  } else if (
    typeof isSerialportAlive !== 'undefined' &&
    typeof isSerialportRetrying !== 'undefined'
  ) {
    getSerialportStatus = () => ({
      isAlive: isSerialportAlive,
      isRetrying: isSerialportRetrying
    });
    logWarn(`${pluginName}: Older Serialport status variables found.`);
  } else {
    if (!alreadyWarnedMissingSerialportVars) {
      alreadyWarnedMissingSerialportVars = true;
      logWarn(`${pluginName}: Serialport status variables not found.`);
    }
  }
})();

function checkSerialportStatus() {
  if (!getSerialportStatus) return;

  const { isAlive, isRetrying } = getSerialportStatus();

  if (!isAlive || isRetrying) {
    if (textSocketLost) {
      clearTimeout(textSocketLost);
    }

    textSocketLost = setTimeout(() => {
      logInfo(`${pluginName} connection lost, creating new WebSocket.`);
      if (textSocket) {
        try {
          textSocket.close(1000, 'Normal closure');
        } catch (error) {
          logInfo(`${pluginName} error closing WebSocket:`, error);
        }
      }
      textSocketLost = null;
    }, 10000);
  }
}

// Function for 'text' WebSocket
async function TextWebSocket(messageData) {
    if (!textSocket || textSocket.readyState === WebSocket.CLOSED) {
        try {
            textSocket = new WebSocket(`${externalWsUrl}/text`);

            textSocket.onopen = () => {

                waitForTextSocket();

                textSocket.onmessage = (event) => {
                    try {
                        // Parse incoming message data
                        const messageData = JSON.parse(event.data);
                        //console.log(messageData);

                        checkSerialportStatus();

                    } catch (error) {
                        logError(`${pluginName} failed to parse WebSocket message:`, error);
                    }
                };
            };

            textSocket.onerror = (error) => logError(`${pluginName} WebSocket error:`, error);

            textSocket.onclose = () => {
                logInfo(`${pluginName} WebSocket closed (/text)`);
                setTimeout(() => TextWebSocket(messageData), 2000); // Pass messageData when reconnecting
            };

        } catch (error) {
            logError(`${pluginName} failed to set up WebSocket:`, error);
            setTimeout(() => TextWebSocket(messageData), 2000); // Pass messageData when reconnecting
        }
    }
}

// WebSocket connection to /data_plugins
async function ExtraWebSocket() {
    if (!extraSocket || extraSocket.readyState === WebSocket.CLOSED) {
        try {
            extraSocket = new WebSocket(`${externalWsUrl}/data_plugins`);

            extraSocket.onopen = () => {
                logInfo(`${pluginName}: Connected to /data_plugins`);
            };

            extraSocket.onerror = (err) => {
                logError(`${pluginName}: WebSocket error:`, err.message);
            };

            extraSocket.onclose = () => {
                logInfo(`${pluginName}: WebSocket closed (/data_plugins)`);
                setTimeout(ExtraWebSocket, 2000);
            };

            // Handle incoming messages from client
            extraSocket.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);

                    // Client requesting current status
                    if (message.type === 'frequency-mute-request-status') {
                        sendToClient(currentStatus);
                    }
                } catch (err) {
                    logError(`${pluginName}: Failed to handle message:`, err.message);
                }
            };

        } catch (error) {
            logError(`${pluginName}: Failed to set up WebSocket:`, error.message);
            setTimeout(ExtraWebSocket, 2000);
        }
    }
}

// Init
checkConfigFile();
loadMutedFrequencies();
ExtraWebSocket();
TextWebSocket();
watchFile();

// Function for first run on startup
function waitForTextSocket() {
    waitForServer();
}

function sendCommand(socket, command, forceUpdate) {
    //logInfo(`[${pluginName}] send command:`, command);
    if (!disablePlugin || forceUpdate) socket.send(command);
}

async function sendCommandToClient(command, forceUpdate) {
    try {
        // Ensure TextWebSocket connection is established
        await TextWebSocket();

        if (!disablePlugin || forceUpdate) {
            if (textSocket && textSocket.readyState === WebSocket.OPEN) {
                //logInfo(`${pluginName}: WebSocket connected, sending command`);
                sendCommand(textSocket, command, forceUpdate);
            } else {
                logError(`${pluginName}: WebSocket is not open. Unable to send command.`);
            }
        }
    } catch (error) {
        logError(`${pluginName}: Failed to send command to client:`, error);
    }
}

let retryFailed = false;

function waitForServer() {
    // Wait for server to become available
    if (typeof textSocket !== "undefined") {
        textSocket.addEventListener("message", (event) => {
            let parsedData;

            // Parse JSON data and handle errors gracefully
            try {
                parsedData = JSON.parse(event.data);
            } catch (err) {
                // Handle error
                logError(`${pluginName} failed to parse JSON:`, err);
                return; // Skip further processing if JSON is invalid
            }

            // Check if parsedData contains expected properties
            const freq = parsedData.freq;

            currentFrequency = freq;

            currentFrequencyRounded = Number(Number(currentFrequency).toFixed(2));
            //logInfo("Frequency:", currentFrequencyRounded);

            if (currentFrequencyRounded !== previousFrequencyRounded) {
                // Check if current frequency matches any frequency in the list
                let newStatus = 'normal';
                let matchedMode = null;

                // Consider floating point precision
                const epsilon = 0.001;

                for (const freqItem of mutedFrequencies) {
                    if (Math.abs(currentFrequencyRounded - freqItem.freq) <= (freqTolerance + epsilon)) {
                        matchedMode = freqItem.mode;
                        newStatus = getStatusFromMode(matchedMode);
                        break;
                    }
                }

                // Only change state if it's different from current state
                if (newStatus !== currentStatus) {
                    currentStatus = newStatus;
                    applyVolumeChange(newStatus);
                    sendToClient(newStatus);
                }

                previousFrequencyRounded = currentFrequencyRounded;
            }

        });
    } else {
        if (retryFailed) {
            logError(`${pluginName}: "textSocket" is not defined.`);
        }
        retryFailed = true;
        setTimeout(waitForServer, 2000);
    }
}

// Intercept BW
let interceptedWData = null;
const originalHandleData = datahandlerReceived.handleData;

// datahandler code
datahandlerReceived.handleData = function(wss, receivedData, rdsWss) {
    const receivedLines = receivedData.split('\n');

    for (const receivedLine of receivedLines) {
        if (receivedLine.startsWith(bandwidthInterceptValue)) {
            interceptedWData = receivedLine.substring(1);
            interceptedWData = interceptedWData.replaceAll(" ", "");

            if (interceptedWData) { // Remove any non-digit characters at the end
                interceptedWData = interceptedWData.replace(/\D+$/, '');
                if (!disablePlugin && (limitManualBandwidth && Number(interceptedWData / 1000) > maxManualBandwidth)) {
                    sendCommandToClient('W0\n');
                    logInfo(`${pluginName}: Bandwidth changed by user to '${interceptedWData / 1000} kHz', forced to 'Auto'`);
                }
            }
            break;
        }
    }

    originalHandleData(wss, receivedData, rdsWss);
};
