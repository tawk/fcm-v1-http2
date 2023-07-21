const async = require('async');
const http2 = require('http2');
const { google } = require('googleapis');

// Define default HTTP/2 multiplexing concurrency (max number of sessions and max number of concurrent streams per session)
const fcmv1Api = 'https://fcm.googleapis.com', defaultMaxConcurrentConnections = 10, defaultMaxConcurrentStreamsAllowed = 100;

// Package constructor
function Client(options) {
    // Set options as instance members
    this.serviceAccount = options.serviceAccount;
    this.maxConcurrentConnections = options.maxConcurrentConnections || defaultMaxConcurrentConnections;
    this.maxConcurrentStreamsAllowed = options.maxConcurrentStreamsAllowed || defaultMaxConcurrentStreamsAllowed;

    // No service account?
    if (!this.serviceAccount) {
        throw new Error('Please provide the service account JSON configuration file.');
    }
}

// Send a notification to multiple devices using HTTP/2 multiplexing
Client.prototype.sendMulticast = function sendMulticast(message, tokens) {
    // Promisify method
    return new Promise((resolve, reject) => {
        // Calculate max devices per batch, and prepare batches array
        let batchLimit = Math.ceil(tokens.length / this.maxConcurrentConnections), tokenBatches = [];

        // Use just one batch/HTTP2 connection if batch limit is less than maxConcurrentStreamsAllowed
        if (batchLimit <= this.maxConcurrentStreamsAllowed) {
            batchLimit = this.maxConcurrentStreamsAllowed;
        }

        // Traverse tokens and split them up into batches of X devices each  
        for (let start = 0; start < tokens.length; start += batchLimit) {
            tokenBatches.push(tokens.slice(start, start + batchLimit));
        }

        // Keep track of unregistered device tokens
        let unregisteredTokens = [];

        // Get OAuth2 token
        getAccessToken(this.serviceAccount).then(function (accessToken) {
            // Count batches to determine when all notifications have been sent
            let done = 0;

            // Send notification using HTTP/2 multiplexing
            for (let tokenBatch of tokenBatches) {
                // Send notification to current token batch
                processBatch.call(this, message, tokenBatch, this.serviceAccount, accessToken).then((unregisteredTokensList) => {
                    // Add unregistred tokens (if any)
                    if (unregisteredTokensList.length > 0)
                        unregisteredTokens.push(unregisteredTokensList);

                    // Done with this batch
                    done++;

                    // If all batches processed, resolve final promise with list of unregistred tokens
                    if (done === tokenBatches.length) {
                        resolve(unregisteredTokens);
                    }
                }).catch((err) => {
                    // Reject promise with error
                    reject(err);
                });
            }
        }.bind(this)).catch((err) => {
            // Failed to generate OAuth2 token
            // most likely due to invalid credentials provided
            reject(err);
        });
    });
}

// Sends notifications to a batch of tokens using HTTP/2
function processBatch(message, devices, serviceAccount, accessToken) {
    // Promisify method
    return new Promise(function (resolve, reject) {
        // Get Firebase project ID from service account credentials
        let projectId = serviceAccount.project_id;

        // Ensure we have a project ID
        if (!projectId) {
            return reject(new Error('Unable to determine Firebase Project ID from service account file.'));
        }

        // Create an HTTP2 client and connect to FCM API
        let client = http2.connect(fcmv1Api, {
            peerMaxConcurrentStreams: this.maxConcurrentConnections
        });

        // Log connection errors
        client.on('error', (err) => {
            reject(err);
        });

        // Log socket errors
        client.on('socketError', (err) => {
            reject(err);
        });

        // Keep track of unregistered device tokens
        client.unregisteredTokens = [];

        // Use async/eachLimit to iterate over device tokens
        async.eachLimit(devices, this.maxConcurrentStreamsAllowed, function (device, doneCallback) {
            // Create a HTTP/2 request per device token
            sendRequest(client, device, message, projectId, accessToken, doneCallback, 0);
        }, function (err) {
            // All requests completed, close the HTTP2 client
            client.close();

            // Reject on error
            if (err) {
                return reject(err);
            }

            // Resolve the promise with list of unregistered tokens
            resolve(client.unregisteredTokens);
        });
    }.bind(this));
}

// Sends a single notification over an existing HTTP/2 client
function sendRequest(client, device, message, projectId, accessToken, doneCallback, tries) {
    // Create a HTTP/2 request per device token
    let request = client.request({
        ':method': 'POST',
        ':scheme': 'https',
        ':path': `/v1/projects/${projectId}/messages:send`,
        Authorization: `Bearer ${accessToken}`,
    });

    // Set encoding as UTF8
    request.setEncoding('utf8');

    // Clone the message object
    let clonedMessage = Object.assign({}, message);

    // Assign device token for the message
    clonedMessage.token = device;

    // Send the request body as stringified JSON
    request.write(
        JSON.stringify({
            // validate_only: true, // Uncomment for dry run
            message: clonedMessage
        })
    );

    // Buffer response data
    let data = '';

    // Add each incoming chunk to response data
    request.on('data', (chunk) => {
        data += chunk;
    });

    // Keep track of called args for retry mechanism
    let args = arguments;

    // Response received in full
    request.on('end', function () {
        try {
            // Convert response body to JSON object
            let response = JSON.parse(data);

            // Error?
            if (response.error) {
                // App uninstall?
                if (response.error.details && response.error.details[0].errorCode === 'UNREGISTERED') {
                    // Add to unregistered tokens list
                    client.unregisteredTokens.push(this);
                }
                else {
                    // Call async done callback with error
                    return doneCallback(response.error);
                }
            }

            // Mark request as completed
            doneCallback();
        }
        catch (err) {
            // Retry up to 3 times (as long as the HTTP2 session is active)
            if (tries <= 3 && !client.destroyed) {
                // Retry request in 5 seconds
                return setTimeout(() => { sendRequest.apply(this, args) }, 5 * 1000);;
            }

            // Log response data in error
            err.data = data;

            // Even if request failed, mark request as completed as we've already retried 3 times
            return doneCallback(err);
        }
    }.bind(device));

    // Log request errors
    request.on('error', (err) => {
        // Call async done callback with parse error
        doneCallback(err);
    });

    // Increment tries
    tries++;

    // Send the current request
    request.end();
}

// OAuth2 access token generation method
function getAccessToken(serviceAccount) {
    return new Promise((resolve, reject) => {
        // Create JWT client with Firebase Messaging scope
        let jwtClient = new google.auth.JWT(
            serviceAccount.client_email,
            null,
            serviceAccount.private_key,
            ['https://www.googleapis.com/auth/firebase.messaging'],
            null
        );

        // Request OAuth2 token
        jwtClient.authorize((err, tokens) => {
            // Reject on error
            if (err)
                return reject(err);

            // Resolve promise with accss token
            resolve(tokens.access_token);
        });
    });
}

// Expose the Client class
module.exports = Client;