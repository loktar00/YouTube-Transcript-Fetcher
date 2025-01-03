const state = {
    conversationHistory: []
};

// Utility functions
const utils = {

    async getCurrentUrl() {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });

        if (!tabs[0]?.url) {
            return null;
        }

        return tabs[0].url;
    },

    async getCurrentVideoId() {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs[0]?.url) return null;
        return new URL(tabs[0].url).searchParams.get("v");
    },

    async getVideoTitle(videoId) {
        try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            return tabs[0]?.title?.replace(' - YouTube', '') || `Video ${videoId}`;
        } catch {
            return `Video ${videoId}`;
        }
    },

    async openPopupWindow(url, options = {}) {
        const defaultOptions = {
            width: 800,
            height: 630,
            type: 'popup'
        };
        return chrome.windows.create({ ...defaultOptions, ...options, url });
    },

    parseTranscriptXml(transcriptXml) {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(transcriptXml, "text/xml");

        // Create a textarea element for decoding HTML entities
        const decoder = document.createElement('textarea');

        return Array.from(xmlDoc.getElementsByTagName('text'))
            .map(node => ({
                text: node.textContent
                    .trim()
                    // Decode HTML entities
                    .replace(/&([^;]+);/g, (match) => {
                        decoder.innerHTML = match;
                        return decoder.value;
                    })
                    // Replace multiple spaces with single space
                    .replace(/\s+/g, ' ')
                    // Remove any remaining newlines
                    .replace(/\n/g, ' '),
                start: parseFloat(node.getAttribute('start')),
                duration: parseFloat(node.getAttribute('dur') || '0')
            }))
            .filter(line => line.text.length > 0)
            .map(line => line.text)
            // Join with single space instead of newline
            .join(' ');
    },

    async fetchYouTubeTranscript(videoId) {
        try {
            const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
                headers: {
                    'Accept-Language': 'en-US',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            const html = await response.text();
            const splitHtml = html.split('"captions":');

            if (splitHtml.length <= 1) {
                throw new Error('No captions found in video');
            }

            const captionsJson = JSON.parse(
                splitHtml[1].split(',"videoDetails')[0].replace(/\n/g, '')
            );

            const captionTracks = captionsJson?.playerCaptionsTracklistRenderer?.captionTracks;
            if (!captionTracks?.length) {
                throw new Error('No caption tracks found');
            }

            const track = captionTracks.find(t => t.languageCode === 'en') || captionTracks[0];
            const transcriptResponse = await fetch(track.baseUrl);
            const transcriptXml = await transcriptResponse.text();

            return this.parseTranscriptXml(transcriptXml);
        } catch (error) {
            console.error('Error fetching transcript:', error);
            throw new Error(`Failed to fetch transcript: ${error.message}`);
        }
    },

    async getPageContent() {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        if (!tab?.id) {
            throw new Error('No active tab found');
        }

        // Inject and execute content script
        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                // Create a clone of the document
                const virtualDoc = document.cloneNode(true);
                const virtualBody = virtualDoc.querySelector('body');

                if (!virtualBody) {
                    return document.body.innerText;
                }

                // Remove unwanted elements from the clone
                const elementsToRemove = virtualBody.querySelectorAll(
                    'script, style, noscript, img, svg, video, audio, nav, footer, header, aside'
                );
                elementsToRemove.forEach(el => el.remove());

                let innerText = '';

                const main = virtualBody.querySelector('main');
                if (main) {
                    innerText += main.innerText;
                }

                innerText += virtualBody.innerText;

                // Clean up multiple line breaks
                return innerText
                    .replace(/\n\s*\n\s*\n/g, '\n\n')  // Replace 3+ line breaks with 2
                    .replace(/\s+/g, ' ')               // Replace multiple spaces with single space
                    .replace(/\n +/g, '\n')             // Remove spaces at start of lines
                    .replace(/ +\n/g, '\n')             // Remove spaces at end of lines
                    .trim();                            // Remove leading/trailing whitespace
            }
        });

        return result;
    },

    estimateTokens(text) {
        if (!text) return 0;

        // Count words (splitting on whitespace and punctuation)
        const words = text.trim().split(/[\s,.!?;:'"()\[\]{}|\\/<>]+/).filter(Boolean);

        // Count numbers (including decimals)
        const numbers = text.match(/\d+\.?\d*/g) || [];

        // Count special tokens (common in code and URLs)
        const specialTokens = text.match(/[+\-*/=_@#$%^&]+/g) || [];

        // Base calculation:
        // - Most words are 1-2 tokens
        // - Numbers are usually 1 token each
        // - Special characters often get their own token
        // - Add 10% for potential underestimation
        const estimate = Math.ceil(
            (words.length * 1.3) +          // Average 1.3 tokens per word
            (numbers.length) +              // Count numbers
            (specialTokens.length) +        // Count special tokens
            (text.length / 100)            // Add small factor for length
        );

        return Math.max(1, estimate);
    },

    calculateConversationTokens(history) {
        // Add extra tokens for message formatting and role indicators
        const formatTokens = history.length * 4; // ~4 tokens per message for format

        // Sum up tokens from all messages
        const contentTokens = history.reduce((total, message) => {
            return total + this.estimateTokens(message.content);
        }, 0);

        return formatTokens + contentTokens;
    }
};

// API interactions
const api = {
    async getApiUrl() {
        const { apiUrl } = await chrome.storage.sync.get("apiUrl");
        return apiUrl || CONSTANTS.API.DEFAULT_API_URL;
    },

    async getAiSettings() {
        const { aiUrl, aiModel, numCtx } = await chrome.storage.sync.get([
            "aiUrl",
            "aiModel",
            "numCtx"
        ]);

        return {
            url: `${aiUrl || CONSTANTS.API.DEFAULT_AI_URL}`,
            model: aiModel || CONSTANTS.API.DEFAULT_AI_MODEL,
            numCtx: numCtx || CONSTANTS.API.DEFAULT_NUM_CTX
        };
    },

    async getSystemPrompt() {
        const { systemPrompt } = await chrome.storage.sync.get(['systemPrompt']);
        return systemPrompt || CONSTANTS.API.DEFAULT_SYSTEM_PROMPT;
    }
};

const chat = {
    async handleStreamingAIResponse(aiSettings, prompt, parentElement) {
        try {
            const baseUrl = aiSettings.url;
            const endpoint = `${baseUrl}/api/chat`;
            let abortController = new AbortController();

            // Setup stop and cancel handlers
            const stopBtn = document.getElementById('stop-generation');
            const cancelBtn = document.getElementById('cancel-generation');

            if (stopBtn) {
                stopBtn.addEventListener('click', () => {
                    abortController.abort();
                });
            }

            if (cancelBtn) {
                cancelBtn.addEventListener('click', () => {
                    abortController.abort();
                    location.reload();
                });
            }

            const requestBody = {
                model: aiSettings.model,
                messages: [
                    ...state.conversationHistory,
                    { role: 'user', content: prompt }
                ],
                options: {
                    temperature: 0.8,
                    num_ctx: aiSettings.numCtx,
                },
                stream: true
            };

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
                signal: abortController.signal
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API request failed (${response.status}): ${errorText || response.statusText}`);
            }

            const reader = response.body.getReader();
            let accumulatedResponse = '';
            let messageElement = null;

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) {
                        break;
                    }

                    const chunk = new TextDecoder().decode(value);
                    const lines = chunk.split('\n');

                    for (const line of lines) {
                        if (!line.trim()) continue;

                        try {
                            const data = JSON.parse(line);
                            if (data.message?.content) {
                                if (!messageElement) {
                                    messageElement = document.createElement('div');
                                    messageElement.className = 'message assistant-message';
                                    parentElement.appendChild(messageElement);
                                }

                                accumulatedResponse += data.message.content;
                                messageElement.innerHTML = markdownToHtml(accumulatedResponse);
                                ui.autoScroll();
                            }
                        } catch (e) {
                            console.error('Error parsing JSON:', e);
                        }
                    }
                }
            } catch (error) {
                if (error.name === 'AbortError') {
                    if (messageElement) {
                        messageElement.innerHTML += '<p><em>Generation stopped by user.</em></p>';
                    }

                    return accumulatedResponse;
                }
                throw error;
            }

            return accumulatedResponse;
        } catch (error) {
            console.error('Error in handleStreamingAIResponse:', error);
            throw error;
        }
    }
};

// Add to the UI utilities section
const ui = {
    toggleChatElements(loading = false) {
        const chatInputContainer = document.querySelector('.chat-input-container');
        const chatLoading = document.querySelector('#chat-loading');
        const loadingControls = document.querySelector('.loading-controls');

        if (loading) {
            chatInputContainer.classList.add('hidden');
            chatLoading.classList.remove('hidden');
            if (loadingControls) {
                loadingControls.classList.remove('hidden');
            }
        } else {
            chatInputContainer.classList.remove('hidden');
            chatLoading.classList.add('hidden');

            if (loadingControls) {
                loadingControls.classList.add('hidden');
            }
        }
    },

    autoScroll(force = false) {
        const element = document.getElementById("chat-messages");
        const isUserScrolledUp = element.scrollHeight - element.clientHeight - element.scrollTop > CONSTANTS.UI.SCROLL_TOLERANCE;

        if (!isUserScrolledUp || force) {
            element.scrollTop = element.scrollHeight;
        }
    },

    async loadSystemPrompt() {
        const systemPromptArea = document.getElementById('system-prompt');
        if (systemPromptArea) {
            const systemPrompt = await api.getSystemPrompt();
            systemPromptArea.value = systemPrompt;

            // Add event listener to save changes
            systemPromptArea.addEventListener('change', async () => {
                await chrome.storage.sync.set({
                    systemPrompt: systemPromptArea.value
                });
            });
        }
    },

    async loadPromptSelector() {
        const selector = document.getElementById('prompt-selector');
        const systemPromptArea = document.getElementById('system-prompt');

        if (!selector || !systemPromptArea) {
            return;
        }

        // Get current URL
        const currentUrl = await utils.getCurrentUrl();

        if (!currentUrl) {
            return;
        }

        // Get all saved prompts
        const { savedPrompts = {} } = await chrome.storage.sync.get('savedPrompts');

        // Clear existing options
        selector.innerHTML = '<option value="default">Default System Prompt</option>';

        // Add saved prompts as options
        Object.entries(savedPrompts).forEach(([pattern, ]) => {
            const option = document.createElement('option');
            option.value = pattern;
            option.textContent = pattern;
            selector.appendChild(option);
        });

        // Find best matching pattern and select it in dropdown
        const bestMatch = promptManager.findBestMatchForUrl(
            currentUrl,
            Object.keys(savedPrompts)
        );

        if (bestMatch) {
            selector.value = bestMatch;
            systemPromptArea.value = savedPrompts[bestMatch];
        } else {
            selector.value = 'default';
            systemPromptArea.value = await api.getSystemPrompt();
        }
    },

    updateTokenCount(container) {
        const tokenDisplay = container.querySelectorAll('.token-display');
        if (!tokenDisplay) {
            return;
        }

        const totalTokens = utils.calculateConversationTokens(state.conversationHistory);
        tokenDisplay.forEach(display => {
            display.textContent = `Total Tokens: ${totalTokens.toLocaleString()} / Context ${state.contextSize.toLocaleString()}`;
        });

        // Add warning class if approaching limit
        tokenDisplay.forEach(display => {
            display.classList.toggle('token-warning',
                totalTokens > state.contextSize * 0.8);
        });
    }
};

// Event handlers
const handlers = {
    async handleFetchWebpage() {
        const transcriptArea = document.getElementById("transcript-area");

        try {
            transcriptArea.value = "Fetching page content...";
            const content = await utils.getPageContent();
            transcriptArea.value = content.trim();
        } catch (error) {
            transcriptArea.value = `Error fetching page content: ${error.message}`;
        }
    },

    async handleFetchTranscript() {
        const videoId = await utils.getCurrentVideoId();
        const transcriptArea = document.getElementById("transcript-area");

        if (!videoId) {
            alert("Could not determine video ID. Please ensure you're on a YouTube video page.");
            return;
        }

        transcriptArea.value = "Fetching transcript...";
        try {
            const transcript = await utils.fetchYouTubeTranscript(videoId);
            transcriptArea.value = transcript;
        } catch (error) {
            transcriptArea.value = `Error fetching transcript: ${error.message}`;
        }
    },

    async handleSummarize() {
        try {
            const transcriptArea = document.getElementById("transcript-area");
            const systemPromptArea = document.getElementById("system-prompt");
            let transcript = transcriptArea.value.trim();

            // Check if we're on YouTube
            const currentUrl = await utils.getCurrentUrl();
            const isYouTube = currentUrl?.includes('youtube.com/watch');

            if (!transcript) {
                if (isYouTube) {
                    await handlers.handleFetchTranscript();
                } else {
                    await handlers.handleFetchWebpage();
                }
                transcript = transcriptArea.value.trim();
            }

            const container = document.querySelector('#panel-content');
            if (!container) {
                return;
            }

            let pageTitle = currentUrl?.title || 'Page Content';

            if (isYouTube) {
                pageTitle = await utils.getVideoTitle(await utils.getCurrentVideoId());
            }

            const aiSettings = await api.getAiSettings();
            state.contextSize = aiSettings.numCtx; // Store context size

            // Initialize conversation history with system prompt and content
            state.conversationHistory = [
                { role: 'system', content: systemPromptArea.value },
                { role: 'user', content: `${pageTitle}\n\n${transcript}` }  // Include full content
            ];

            // Render the summary template
            container.innerHTML = renderTemplate('summary', {
                title: pageTitle,
                model: aiSettings.model,
                transcript: `${pageTitle}\n\n${transcript}`
            });

            // Update initial token count with full content
            ui.updateTokenCount(container);

            // Get references to elements after template is rendered
            const elements = {
                chatContainer: container.querySelector('#chat-container'),
                formattedSummary: container.querySelector('#formatted-summary'),
                chatLoading: container.querySelector('#chat-loading'),
                chatInput: container.querySelector('#chat-input'),
                sendButton: container.querySelector('#send-message'),
                backButton: container.querySelector('#back-to-transcript')
            };

            if (!elements.chatContainer || !elements.formattedSummary || !elements.chatLoading) {
                console.error('Required elements not found after template render');
                return;
            }

            elements.backButton.addEventListener('click', () => location.reload());

            // Add transcript as first message
            elements.formattedSummary.innerHTML = `
                <div class="message user-message">
                    <div>
                        ${markdownToHtml(`${systemPromptArea.value}\n\n${transcript}`)}
                    </div>
                </div>
            `;

            ui.autoScroll(true);

            try {
                ui.toggleChatElements(true);

                const response = await chat.handleStreamingAIResponse(
                    aiSettings,
                    transcript,
                    elements.formattedSummary
                );

                state.conversationHistory.push(
                    { role: 'user', content: transcript },
                    { role: 'assistant', content: response }
                );

                ui.toggleChatElements(false);

                if (elements.chatInput && elements.sendButton) {
                    setupStreamingChatHandlers(
                        elements.formattedSummary,
                        elements.chatInput,
                        elements.sendButton,
                        aiSettings
                    );
                }
            } catch (error) {
                elements.chatLoading.innerHTML = `
                    <div class="error-text">
                        Error generating summary: ${error.message}
                    </div>
                `;
                ui.toggleChatElements(false);
                ui.autoScroll(true);
            }
        } catch (error) {
            console.error('Error in handleSummarize:', error);
            alert(`Failed to generate summary: ${error.message}`);
        }
    },

    async handleCopyToClipboard() {
        const transcriptArea = document.getElementById("transcript-area");
        try {
            await navigator.clipboard.writeText(transcriptArea.value);
            alert("Transcript copied to clipboard!");
        } catch (error) {
            alert(`Failed to copy text to clipboard. ${error.message}`);
        }
    },

    async handleOpenSettings() {
        await utils.openPopupWindow('options.html', {
            width: 500,  // Smaller width for settings
            height: 700
        });
    },

    async handleManagePrompts() {
        const container = document.querySelector('#panel-content');
        if (!container) {
            return;
        }

        // Save current content to restore later if needed
        const previousContent = container.innerHTML;

        // Render prompt manager
        container.innerHTML = renderTemplate('promptManager', {});

        // Initialize prompt manager
        initializePromptManager();

        // Add back button
        const backBtn = document.createElement('button');
        backBtn.className = 'btn';
        backBtn.textContent = '← Back';
        backBtn.addEventListener('click', () => {
            container.innerHTML = previousContent;
            initializeUI(); // Reinitialize main UI
        });

        // Insert back button at the top
        const promptManager = container.querySelector('.prompt-manager');
        promptManager.insertBefore(backBtn, promptManager.firstChild);
    }
};

// Updated chat handlers to support streaming and markdown
async function setupStreamingChatHandlers(formattedSummary, chatInput, sendButton, aiSettings) {
    async function sendMessage() {
        const message = chatInput.value.trim();
        if (!message) return;

        // Create message elements
        const userMessage = document.createElement('div');
        userMessage.className = 'message user-message';
        userMessage.innerHTML = `
            <div>
                ${markdownToHtml(message)}
            </div>
        `;

        ui.autoScroll(true);

        formattedSummary.appendChild(userMessage);

        chatInput.value = '';
        ui.toggleChatElements(true);
        ui.autoScroll(true);

        try {
            state.conversationHistory.push({
                role: 'user',
                content: message
            });

            // Update token count
            ui.updateTokenCount(formattedSummary.closest('.chat-container'));

            // Create and append AI message element
            const aiMessage = document.createElement('div');
            formattedSummary.appendChild(aiMessage);

            // Send just the message, not the whole conversation history
            const response = await chat.handleStreamingAIResponse(
                aiSettings,
                message,  // Send only the latest message
                aiMessage
            );

            state.conversationHistory.push({
                role: 'assistant',
                content: response
            });

            // Update token count again after response
            ui.updateTokenCount(formattedSummary.closest('.chat-container'));

            ui.autoScroll(true);
        } catch (error) {
            console.error('Chat error:', error);
        } finally {
            ui.toggleChatElements(false);
            chatInput.focus();
        }
    }

    sendButton.addEventListener('click', sendMessage);
    chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });
}

// Initialize function that handles both popup and side panel
function initializeUI() {
    const elements = {
        openOptions: document.getElementById("open-options"),
        managePrompts: document.getElementById("manage-prompts"),
        fetchTranscript: document.getElementById("fetch-current-transcript"),
        fetchWebpage: document.getElementById("fetch-webpage"),
        copyClipboard: document.getElementById("copy-to-clipboard"),
        summarize: document.getElementById("summarize-transcript"),
        promptSelector: document.getElementById("prompt-selector"),
        systemPrompt: document.getElementById("system-prompt")
    };

    // Main button handlers
    elements.openOptions?.addEventListener("click", handlers.handleOpenSettings);
    elements.managePrompts?.addEventListener("click", handlers.handleManagePrompts);
    elements.fetchTranscript?.addEventListener("click", handlers.handleFetchTranscript);
    elements.fetchWebpage?.addEventListener("click", handlers.handleFetchWebpage);
    elements.copyClipboard?.addEventListener("click", handlers.handleCopyToClipboard);
    elements.summarize?.addEventListener("click", handlers.handleSummarize);

    // Prompt selector handler - only updates textarea content
    if (elements.promptSelector && elements.systemPrompt) {
        elements.promptSelector.addEventListener('change', async () => {
            const { savedPrompts = {} } = await chrome.storage.sync.get('savedPrompts');
            const defaultPrompt = await api.getSystemPrompt();

            const selectedPattern = elements.promptSelector.value;
            elements.systemPrompt.value = selectedPattern === 'default'
                ? defaultPrompt
                : savedPrompts[selectedPattern];
        });
    }

    // Load initial prompts and system prompt
    ui.loadSystemPrompt();
    ui.loadPromptSelector();
}

const promptManager = {
    async savePrompt(pattern, prompt) {
        const { savedPrompts = {} } = await chrome.storage.sync.get('savedPrompts');
        // Remove www. and clean pattern
        const cleanPattern = pattern.replace(/^www\./, '');
        savedPrompts[cleanPattern] = prompt;
        await chrome.storage.sync.set({ savedPrompts });
    },

    patternToRegex(pattern) {
        // Split into path and query parts
        const [pathPart, queryPart] = pattern.split('?');

        // Build path regex
        let pathRegex = '^' + pathPart
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape special regex chars except *
            .replace(/\*/g, '[^?]*');              // * matches anything except ?

        // Add query parameters if they exist
        if (queryPart) {
            pathRegex += '\\?';
            const queryParams = queryPart.split('&').map(param => {
                return param.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
                    .replace(/\*/g, '[^&]*');
            });

            // Allow query parameters in any order
            pathRegex += queryParams
                .map(param => `(?=.*${param})`)
                .join('');

            pathRegex += '[^#]*';  // Match rest of query string until fragment
        }

        return new RegExp(pathRegex);
    },

    findBestMatchForUrl(url, patterns) {
        // Clean the URL for matching
        const cleanUrl = url.replace(/^www\./, '');

        // Convert patterns to regex and find matches
        const matches = patterns
            .map(pattern => ({
                pattern,
                regex: this.patternToRegex(pattern),
                specificity: this.calculateSpecificity(pattern)
            }))
            .filter(({ regex }) => {
                try {
                    return regex.test(cleanUrl);
                } catch (e) {
                    console.error('Regex error for pattern:', pattern, e);
                    return false;
                }
            })
            .sort((a, b) => {
                // Sort by specificity first
                const specificityDiff = b.specificity - a.specificity;
                if (specificityDiff !== 0) return specificityDiff;

                // If same specificity, prefer longer pattern
                return b.pattern.length - a.pattern.length;
            });

        return matches[0]?.pattern;
    },

    calculateSpecificity(pattern) {
        // Count non-wildcard segments
        const segments = pattern.split('/');
        const queryParts = pattern.split('?')[1]?.split('&') || [];

        return segments.filter(s => s !== '*').length +
               queryParts.filter(p => p !== '*').length;
    }
};

async function loadPrompts() {
    const promptsList = document.getElementById('prompts-list');
    const { savedPrompts = {} } = await chrome.storage.sync.get('savedPrompts');

    promptsList.innerHTML = Object.entries(savedPrompts)
        .map(([pattern, content]) => renderTemplate('promptItem', { pattern, content }))
        .join('');
}

function initializePromptManager() {
    const saveBtn = document.getElementById('save-prompt');
    const useCurrentUrlBtn = document.getElementById('use-current-url');
    const patternInput = document.getElementById('prompt-pattern');
    const promptContent = document.getElementById('prompt-content');
    const promptsList = document.getElementById('prompts-list');

    useCurrentUrlBtn?.addEventListener('click', async () => {
        const url = await utils.getCurrentUrl();
        patternInput.value = url;
    });

    saveBtn?.addEventListener('click', async () => {
        const pattern = patternInput.value.trim();
        const content = promptContent.value.trim();

        if (!pattern || !content) {
            return;
        }

        await promptManager.savePrompt(pattern, content);
        await loadPrompts();

        patternInput.value = '';
        promptContent.value = '';
    });

    promptsList?.addEventListener('click', async (e) => {
        const action = e.target.dataset.action;
        const pattern = e.target.dataset.pattern;
        const content = e.target.dataset.content;

        if (!action || !pattern) {
            return;
        }

        if (action === 'edit') {
            patternInput.value = pattern;
            promptContent.value = content;
        }

        if (action === 'delete') {
            const { savedPrompts = {} } = await chrome.storage.sync.get('savedPrompts');
            delete savedPrompts[pattern];
            await chrome.storage.sync.set({ savedPrompts });
            await loadPrompts();
        }
    });

    loadPrompts();
}