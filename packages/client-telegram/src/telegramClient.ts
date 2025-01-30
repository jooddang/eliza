import { Context, Telegraf } from "telegraf";
import { message } from "telegraf/filters";
import { IAgentRuntime, elizaLogger, UUID, Memory, Content, getEmbeddingZeroVector, HandlerCallback } from "@elizaos/core";
import { MessageManager } from "./messageManager.ts";
import { getOrCreateRecommenderInBe } from "./getOrCreateRecommenderInBe.ts";
import { composeContext, stringToUuid, generateShouldRespond, ModelClass, composeRandomUser, telegramShouldRespondTemplate, telegramMessageHandlerTemplate } from './utils';
import { IImageDescriptionService, ServiceType } from "@elizaos/core";

export class TelegramClient {
    private bot: Telegraf<Context>;
    private runtime: IAgentRuntime;
    private messageManager: MessageManager;
    private backend;
    private backendToken;
    private tgTrader;
    private options;

    constructor(runtime: IAgentRuntime, botToken: string) {
        elizaLogger.log("📱 Constructing new TelegramClient...");
        this.options = {
            telegram: {
                apiRoot: runtime.getSetting("TELEGRAM_API_ROOT") || process.env.TELEGRAM_API_ROOT || "https://api.telegram.org"
            },
        };
        this.runtime = runtime;
        this.bot = new Telegraf(botToken,this.options);
        this.messageManager = new MessageManager(this.bot, this.runtime);
        this.backend = runtime.getSetting("BACKEND_URL");
        this.backendToken = runtime.getSetting("BACKEND_TOKEN");
        this.tgTrader = runtime.getSetting("TG_TRADER"); // boolean To Be added to the settings
        elizaLogger.log("✅ TelegramClient constructor completed");
    }

    public async start(): Promise<void> {
        elizaLogger.log("🚀 Starting Telegram bot...");
        try {
            await this.initializeBot();
            this.setupMessageHandlers();
            this.setupShutdownHandlers();
        } catch (error) {
            elizaLogger.error("❌ Failed to launch Telegram bot:", error);
            throw error;
        }
    }

    private async initializeBot(): Promise<void> {
        this.bot.launch({ dropPendingUpdates: true });
        elizaLogger.log(
            "✨ Telegram bot successfully launched and is running!"
        );

        const botInfo = await this.bot.telegram.getMe();
        this.bot.botInfo = botInfo;
        elizaLogger.success(`Bot username: @${botInfo.username}`);

        this.messageManager.bot = this.bot;
    }

    private async isGroupAuthorized(ctx: Context): Promise<boolean> {
        const config = this.runtime.character.clientConfig?.telegram;
        if (ctx.from?.id === ctx.botInfo?.id) {
            return false;
        }

        if (!config?.shouldOnlyJoinInAllowedGroups) {
            return true;
        }

        const allowedGroups = config.allowedGroupIds || [];
        const currentGroupId = ctx.chat.id.toString();

        if (!allowedGroups.includes(currentGroupId)) {
            elizaLogger.info(`Unauthorized group detected: ${currentGroupId}`);
            try {
                await ctx.reply("Not authorized. Leaving.");
                await ctx.leaveChat();
            } catch (error) {
                elizaLogger.error(
                    `Error leaving unauthorized group ${currentGroupId}:`,
                    error
                );
            }
            return false;
        }

        return true;
    }

    private setupMessageHandlers(): void {
        elizaLogger.log("Setting up message handler...");

        this.bot.on(message("new_chat_members"), async (ctx) => {
            try {
                const newMembers = ctx.message.new_chat_members;
                const isBotAdded = newMembers.some(
                    (member) => member.id === ctx.botInfo.id
                );

                if (isBotAdded && !(await this.isGroupAuthorized(ctx))) {
                    return;
                }
            } catch (error) {
                elizaLogger.error("Error handling new chat members:", error);
            }
        });

        this.bot.on("message", async (ctx) => {
            try {
                // Check group authorization first
                if (!(await this.isGroupAuthorized(ctx))) {
                    return;
                }

                if (this.tgTrader) {
                    const userId = ctx.from?.id.toString();
                    const username =
                        ctx.from?.username || ctx.from?.first_name || "Unknown";
                    if (!userId) {
                        elizaLogger.warn(
                            "Received message from a user without an ID."
                        );
                        return;
                    }
                    try {
                        await getOrCreateRecommenderInBe(
                            userId,
                            username,
                            this.backendToken,
                            this.backend
                        );
                    } catch (error) {
                        elizaLogger.error(
                            "Error getting or creating recommender in backend",
                            error
                        );
                    }
                }

                await this.messageManager.handleMessage(ctx);
            } catch (error) {
                elizaLogger.error("❌ Error handling message:", error);
                // Don't try to reply if we've left the group or been kicked
                if (error?.response?.error_code !== 403) {
                    try {
                        await ctx.reply(
                            "An error occurred while processing your message."
                        );
                    } catch (replyError) {
                        elizaLogger.error(
                            "Failed to send error message:",
                            replyError
                        );
                    }
                }
            }
        });

        this.bot.on("photo", (ctx) => {
            elizaLogger.log(
                "📸 Received photo message with caption:",
                ctx.message.caption
            );
        });

        this.bot.on("document", (ctx) => {
            elizaLogger.log(
                "📎 Received document message:",
                ctx.message.document.file_name
            );
        });

        this.bot.catch((err, ctx) => {
            elizaLogger.error(`❌ Telegram Error for ${ctx.updateType}:`, err);
            ctx.reply("An unexpected error occurred. Please try again later.");
        });
    }

    private setupShutdownHandlers(): void {
        const shutdownHandler = async (signal: string) => {
            elizaLogger.log(
                `⚠️ Received ${signal}. Shutting down Telegram bot gracefully...`
            );
            try {
                await this.stop();
                elizaLogger.log("🛑 Telegram bot stopped gracefully");
            } catch (error) {
                elizaLogger.error(
                    "❌ Error during Telegram bot shutdown:",
                    error
                );
                throw error;
            }
        };

        process.once("SIGINT", () => shutdownHandler("SIGINT"));
        process.once("SIGTERM", () => shutdownHandler("SIGTERM"));
        process.once("SIGHUP", () => shutdownHandler("SIGHUP"));
    }

    public async stop(): Promise<void> {
        elizaLogger.log("Stopping Telegram bot...");
        //await 
            this.bot.stop();
        elizaLogger.log("Telegram bot stopped");
    }


    private _isMessageForMe(message: any): boolean {
        return message.text.includes(`@${this.bot.botInfo.username}`);
    }

    private _shouldRespondBasedOnContext(message: any, chatState: any): boolean {
        return chatState.currentHandler === "telegramMessageHandler";
    }

    private interestChats: Record<string, any> = {};

    private async _shouldRespond(
        message: any,
        state: any
    ): Promise<boolean> {
        // Always respond if bot is mentioned
        if (this._isMessageForMe(message)) {
            elizaLogger.info(`Bot mentioned`);
            return true;
        }
        // Respond to private chats
        if (message.chat.type === "private") {
            return true;
        }
        // Respond to group chats based on content and context
        const chatId = message.chat.id.toString();
        const chatState = this.interestChats[chatId];
        const messageText = "text" in message ? message.text : "caption" in message ? (message as any).caption : "";
        if (chatState) {
            const shouldRespondContext = await this._shouldRespondBasedOnContext(message, chatState);
            return shouldRespondContext;
        }
        // Use AI to decide for text or captions
        if (messageText) {
            const shouldRespondContext = composeContext({
                state,
                template: this.runtime.character.templates?.telegramShouldRespondTemplate || this.runtime.character?.templates?.shouldRespondTemplate || composeRandomUser(telegramShouldRespondTemplate, 2),
            });
            const response = await generateShouldRespond({
                runtime: this.runtime,
                context: shouldRespondContext,
                modelClass: ModelClass.SMALL,
            });
            return response === "RESPOND";
        }
        return false;
    }

    public async handleMessage(ctx: Context): Promise<void> {
        if (!ctx.message || !ctx.from) {
            return; // Exit if no message or sender info
        }
        if (this.runtime.character.clientConfig?.telegram?.shouldIgnoreBotMessages && ctx.from.is_bot) {
            return;
        }
        if (this.runtime.character.clientConfig?.telegram?.shouldIgnoreDirectMessages && ctx.chat?.type === "private") {
            return;
        }
        const message = ctx.message;
        const chatId = ctx.chat?.id.toString();
        const messageText = "text" in message ? message.text : "caption" in message ? (message as any).caption : "";
        // Track all messages in the group chat
        if (chatId && messageText) {
            this.interestChats[chatId] = this.interestChats[chatId] || { currentHandler: undefined, lastMessageSent: 0, messages: [] };
            this.interestChats[chatId].messages.push({
                userId: stringToUuid(ctx.from.id.toString()),
                userName: ctx.from.username || ctx.from.first_name || "Unknown User",
                content: { text: messageText, source: "telegram" },
            });
            this.interestChats[chatId].lastMessageSent = Date.now();
        }
        // Process the message and decide whether to respond
        try {
            const userId = stringToUuid(ctx.from.id.toString()) as UUID;
            const userName = ctx.from.username || ctx.from.first_name || "Unknown User";
            const roomId = stringToUuid(chatId + "-" + this.runtime.agentId) as UUID;
            const agentId = this.runtime.agentId;
            await this.runtime.ensureConnection(userId, roomId, userName, userName, "telegram");
            const messageId = stringToUuid(message.message_id.toString() + "-" + this.runtime.agentId) as UUID;
            const imageInfo = await this.processImage(message);
            const fullText = imageInfo ? `${messageText} ${imageInfo.description}` : messageText;
            if (!fullText) {
                return; // Skip if no content
            }
            const content: Content = {
                text: fullText,
                source: "telegram",
                inReplyTo: "reply_to_message" in message && message.reply_to_message ? stringToUuid(message.reply_to_message.message_id.toString() + "-" + this.runtime.agentId) : undefined,
            };
            const memory: Memory = {
                id: messageId,
                agentId,
                userId,
                roomId,
                content,
                createdAt: message.date * 1000,
                embedding: getEmbeddingZeroVector(),
            };
            await this.runtime.messageManager.createMemory(memory);
            let state = await this.runtime.composeState(memory);
            state = await this.runtime.updateRecentMessageState(state);
            const shouldRespond = await this._shouldRespond(message, state);
            if (shouldRespond) {
                const context = composeContext({
                    state,
                    template: this.runtime.character.templates?.telegramMessageHandlerTemplate || this.runtime.character?.templates?.messageHandlerTemplate || telegramMessageHandlerTemplate,
                });
                const responseContent = await this._generateResponse(memory, state, context);
                if (!responseContent || !responseContent.text) return;
                const callback: HandlerCallback = async (content: Content) => {
                    const sentMessages = await this.sendMessageInChunks(ctx, content, message.message_id);
                    if (sentMessages) {
                        const memories: Memory[] = [];
                        for (let i = 0; i < sentMessages.length; i++) {
                            const sentMessage = sentMessages[i];
                            const isLastMessage = i === sentMessages.length - 1;
                            const memory: Memory = {
                                id: stringToUuid(sentMessage.message_id.toString() + "-" + this.runtime.agentId),
                                agentId,
                                userId: agentId,
                                roomId,
                                content: {
                                    ...content,
                                    text: sentMessage.text,
                                    inReplyTo: messageId,
                                },
                                createdAt: sentMessage.date * 1000,
                                embedding: getEmbeddingZeroVector(),
                            };
                            memory.content.action = !isLastMessage ? "CONTINUE" : content.action;
                            await this.runtime.messageManager.createMemory(memory);
                            memories.push(memory);
                        }
                        return memories;
                    }
                };
                const responseMessages = await callback(responseContent);
                state = await this.runtime.updateRecentMessageState(state);
                await this.runtime.processActions(memory, responseMessages, state, callback);
            }
            await this.runtime.evaluate(memory, state, shouldRespond);
        } catch (error) {
            elizaLogger.error("❌ Error handling message:", error);
            elizaLogger.error("Error sending message:", error);
        }
    }

    private async processImage(message: any): Promise<{ description: string } | null> {
        try {
            let imageUrl: string | null = null;

            if ("photo" in message && message.photo?.length > 0) {
                const photo = message.photo[message.photo.length - 1];
                const fileLink = await this.bot.telegram.getFileLink(photo.file_id);
                imageUrl = fileLink.toString();
            } else if ("document" in message && message.document?.mime_type?.startsWith("image/")) {
                const fileLink = await this.bot.telegram.getFileLink(message.document.file_id);
                imageUrl = fileLink.toString();
            }

            if (imageUrl) {
                const imageDescriptionService = this.runtime.getService<IImageDescriptionService>(ServiceType.IMAGE_DESCRIPTION);
                if (imageDescriptionService) {
                    const { title, description } = await imageDescriptionService.describeImage(imageUrl);
                    return { description: `[Image: ${title}\n${description}]` };
                }
            }
        } catch (error) {
            elizaLogger.error("Error processing image:", error);
        }

        return null;
    }

    private async _generateResponse(
        message: Memory,
        state: any,
        context: string
    ): Promise<Content | null> {
        try {
            const memory: Memory = {
                id: stringToUuid(Date.now().toString()),
                userId: this.runtime.agentId,
                agentId: this.runtime.agentId,
                roomId: message.roomId,
                content: {
                    text: context,
                    source: "telegram"
                },
                embedding: getEmbeddingZeroVector()
            };

            await this.runtime.messageManager.createMemory(memory);
            const response = await this.runtime.messageManager.searchMemoriesByEmbedding(
                memory.embedding,
                {
                    match_threshold: 0.8,
                    count: 1,
                    roomId: memory.roomId,
                    unique: true
                }
            );

            return response[0]?.content || null;
        } catch (error) {
            elizaLogger.error("Error generating response:", error);
            return null;
        }
    }

    private async sendMessageInChunks(
        ctx: Context,
        content: Content,
        replyToMessageId?: number
    ): Promise<any[]> {
        const chunks = this.splitMessage(content.text || "", 4096);
        const sentMessages = [];

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const sentMessage = await ctx.telegram.sendMessage(ctx.chat.id, chunk, {
                reply_parameters: i === 0 && replyToMessageId
                    ? { message_id: replyToMessageId }
                    : undefined,
                parse_mode: "Markdown",
            });
            sentMessages.push(sentMessage);
        }

        return sentMessages;
    }

    private splitMessage(text: string, maxLength: number = 4096): string[] {
        const chunks: string[] = [];
        let currentChunk = "";

        const lines = text.split("\n");
        for (const line of lines) {
            if (currentChunk.length + line.length + 1 <= maxLength) {
                currentChunk += (currentChunk ? "\n" : "") + line;
            } else {
                if (currentChunk) chunks.push(currentChunk);
                currentChunk = line;
            }
        }

        if (currentChunk) chunks.push(currentChunk);
        return chunks;
    }
}
