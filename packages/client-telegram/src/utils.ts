import { IAgentRuntime, elizaLogger, UUID, Memory, getEmbeddingZeroVector } from "@elizaos/core";

export enum ModelClass {
    SMALL = "small",
    MEDIUM = "medium",
    LARGE = "large"
}

interface GenerateShouldRespondParams {
    runtime: IAgentRuntime;
    context: string;
    modelClass?: ModelClass;
}

/**
 * Composes a random user name
 * @param template Template string to fill
 * @param count Number of users to generate
 * @returns Processed template with random users
 */
export function composeRandomUser(template: string, count: number): string {
    const users = Array(count).fill(0).map((_, i) => {
        const adjectives = ["sick", "cool", "awesome", "amazing", "great"];
        const nouns = ["user", "person", "individual", "human", "being"];
        const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
        const noun = nouns[Math.floor(Math.random() * nouns.length)];
        return `{{user${i + 1}}}`.replace(`{{user${i + 1}}}`, `${adjective} ${noun}`);
    });

    let result = template;
    users.forEach((user, i) => {
        result = result.replace(`{{user${i + 1}}}`, user);
    });
    return result;
}


/**
 * Generates a decision on whether the bot should respond to a message
 * @param params Configuration object containing runtime, context, and optional model class
 * @returns Promise resolving to "RESPOND" or "IGNORE"
 */
export async function generateShouldRespond(
    params: GenerateShouldRespondParams
): Promise<"RESPOND" | "IGNORE"> {
    const { runtime, context, modelClass = ModelClass.SMALL } = params;

    try {
        const prompt = `
Based on the following context, determine if the bot should respond. Consider:
- Is the message directed at or relevant to the bot?
- Is it part of an ongoing conversation?
- Does it require a response?

Context:
${context}

Respond with exactly one word: either "RESPOND" or "IGNORE".
`;

        // Create a memory for the prompt
        const memory: Memory = {
            id: stringToUuid(Date.now().toString()),
            userId: runtime.agentId,
            agentId: runtime.agentId,
            roomId: stringToUuid("should-respond"),
            content: {
                text: prompt,
                source: "telegram"
            },
            embedding: getEmbeddingZeroVector()
        };

        // Use messageManager to create and process the memory
        await runtime.messageManager.createMemory(memory);
        const state = await runtime.composeState(memory);

        // Generate response using messageManager
        const response = await runtime.messageManager.searchMemoriesByEmbedding(
            memory.embedding,
            {
                match_threshold: 0.8,
                count: 1,
                roomId: memory.roomId,
                unique: true
            }
        );

        // Get the decision from the response
        const decision = response[0]?.content?.text?.trim().toUpperCase() || "IGNORE";

        if (decision !== "RESPOND" && decision !== "IGNORE") {
            elizaLogger.warn(
                `Invalid response from model: ${decision}. Defaulting to IGNORE`
            );
            return "IGNORE";
        }

        elizaLogger.debug(`Should respond decision: ${decision}`);
        return decision;

    } catch (error) {
        elizaLogger.error("Error generating should-respond decision:", error);
        return "IGNORE"; // Default to ignoring on error
    }
}

// Example usage:
/*
const shouldRespond = await generateShouldRespond({
    runtime: agentRuntime,
    context: "User asked: What's the weather like?",
    modelClass: ModelClass.SMALL
});

if (shouldRespond === "RESPOND") {
    // Generate and send response
}
*/

interface ComposeContextParams {
    state: Record<string, any>;
    template: string;
    defaultValues?: Record<string, any>;
    formatters?: Record<string, (value: any) => string>;
}

/**
 * Composes a context string by combining a template with state data
 * @param params Configuration object for context composition
 * @returns Composed context string with variables replaced
 */
export function composeContext(params: ComposeContextParams): string {
    const { state, template, defaultValues = {}, formatters = {} } = params;

    // Helper function to get nested value from object
    const getNestedValue = (obj: any, path: string[]): any => {
        return path.reduce((acc, key) => {
            if (acc === undefined) return undefined;
            return acc[key];
        }, obj);
    };

    // Helper function to format value based on type or custom formatter
    const formatValue = (value: any, formatterName?: string): string => {
        if (formatterName && formatterName in formatters) {
            return formatters[formatterName](value);
        }

        if (value === null || value === undefined) {
            return '';
        }

        if (Array.isArray(value)) {
            return value.join(', ');
        }

        if (typeof value === 'object') {
            return JSON.stringify(value);
        }

        return String(value);
    };

    // Replace template variables
    const composedContext = template.replace(
        /\{\{([^}|]+)(?:\|([^}]+))?\}\}/g,
        (match, variable, formatter) => {
            const path = variable.trim().split('.');

            // Try to get value from state
            let value = getNestedValue(state, path);

            // If not found in state, try default values
            if (value === undefined) {
                value = getNestedValue(defaultValues, path);
            }

            // Log warning if value is still undefined
            if (value === undefined) {
                elizaLogger.warn(
                    `Variable ${variable} not found in state or default values`
                );
                return match; // Keep original {{variable}} if not found
            }

            return formatValue(value, formatter);
        }
    );

    return composedContext;
}

// Example usage with formatters:
/*
const state = {
    user: {
        name: "John",
        joinDate: new Date("2024-01-01"),
        tags: ["admin", "moderator"]
    }
};

const defaultValues = {
    agent: {
        name: "DefaultBot"
    }
};

const formatters = {
    date: (value: Date) => value.toLocaleDateString(),
    upper: (value: string) => value.toUpperCase(),
    list: (value: string[]) => value.join(' | ')
};

const template = `
User: {{user.name|upper}}
Joined: {{user.joinDate|date}}
Tags: {{user.tags|list}}
Bot: {{agent.name}}
`;

const context = composeContext({
    state,
    template,
    defaultValues,
    formatters
});
*/

export function cosineSimilarity(text1: string, text2: string, text3?: string): number {
    const preprocessText = (text: string) => text
        .toLowerCase()
        .replace(/[^\w\s'_-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const getWords = (text: string) => {
        return text.split(" ").filter((word) => word.length > 1);
    };

    const words1 = getWords(preprocessText(text1));
    const words2 = getWords(preprocessText(text2));
    const words3 = text3 ? getWords(preprocessText(text3)) : [];

    const freq1: { [key: string]: number } = {};
    const freq2: { [key: string]: number } = {};
    const freq3: { [key: string]: number } = {};

    words1.forEach((word) => (freq1[word] = (freq1[word] || 0) + 1));
    words2.forEach((word) => (freq2[word] = (freq2[word] || 0) + 1));
    if (words3.length) {
        words3.forEach((word) => (freq3[word] = (freq3[word] || 0) + 1));
    }

    const uniqueWords = new Set([
        ...Object.keys(freq1),
        ...Object.keys(freq2),
        ...(words3.length ? Object.keys(freq3) : []),
    ]);

    let dotProduct = 0;
    let magnitude1 = 0;
    let magnitude2 = 0;
    let magnitude3 = 0;

    uniqueWords.forEach((word) => {
        const val1 = freq1[word] || 0;
        const val2 = freq2[word] || 0;
        const val3 = freq3[word] || 0;

        if (words3.length) {
            // For three-way, calculate pairwise similarities
            const sim12 = val1 * val2;
            const sim23 = val2 * val3;
            const sim13 = val1 * val3;

            // Take maximum similarity between any pair
            dotProduct += Math.max(sim12, sim23, sim13);
        } else {
            dotProduct += val1 * val2;
        }

        magnitude1 += val1 * val1;
        magnitude2 += val2 * val2;
        if (words3.length) {
            magnitude3 += val3 * val3;
        }
    });

    magnitude1 = Math.sqrt(magnitude1);
    magnitude2 = Math.sqrt(magnitude2);
    magnitude3 = words3.length ? Math.sqrt(magnitude3) : 1;

    if (
        magnitude1 === 0 ||
        magnitude2 === 0 ||
        (words3.length && magnitude3 === 0)
    )
        return 0;

    // For two texts, use original calculation
    if (!words3.length) {
        return dotProduct / (magnitude1 * magnitude2);
    }

    // For three texts, use max magnitude pair to maintain scale
    const maxMagnitude = Math.max(
        magnitude1 * magnitude2,
        magnitude2 * magnitude3,
        magnitude1 * magnitude3
    );

    return dotProduct / maxMagnitude;
}

export function escapeMarkdown(text: string): string {
    // Don't escape if it's a code block
    if (text.startsWith("```") && text.endsWith("```")) {
        return text;
    }

    // Split the text by code blocks
    const parts = text.split(/(```[\s\S]*?```)/g);

    return parts
        .map((part, index) => {
            // If it's a code block (odd indices in the split result will be code blocks)
            if (index % 2 === 1) {
                return part;
            }
            // For regular text, only escape characters that need escaping in Markdown
            return (
                part
                    // First preserve any intended inline code spans
                    .replace(/`.*?`/g, (match) => match)
                    // Then only escape the minimal set of special characters that need escaping in Markdown mode
                    .replace(/([*_`\\])/g, "\\$1")
            );
        })
        .join("");
}

/**
 * Splits a message into chunks that fit within Telegram's message length limit
 */
export function splitMessage(text: string, maxLength: number = 4096): string[] {
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

/**
 * Converts a string to a UUID format using a simple hashing algorithm
 * @param str Input string to convert
 * @returns UUID formatted string
 */
export function stringToUuid(str: string): UUID {
    // Create a hash of the string
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }

    // Convert hash to hex and pad with zeros
    const hashHex = Math.abs(hash).toString(16).padStart(32, '0');

    // Format as UUID (8-4-4-4-12)
    return `${hashHex.slice(0, 8)}-${hashHex.slice(8, 12)}-${hashHex.slice(12, 16)}-${hashHex.slice(16, 20)}-${hashHex.slice(20, 32)}` as UUID;
}

export const telegramShouldRespondTemplate = `# About {{agentName}}:
{{bio}}

# RESPONSE EXAMPLES
{{user1}}: I just saw a really great movie
{{user2}}: Oh? Which movie?
Result: [IGNORE]

{{agentName}}: Oh, this is my favorite scene
{{user1}}: sick
{{user2}}: wait, why is it your favorite scene
Result: [RESPOND]

{{user1}}: stfu bot
Result: [STOP]

{{recentMessages}}

Thread of Tweets You Are Replying To:

{{formattedConversation}}

# INSTRUCTIONS: Choose the option that best describes {{agentName}}'s response to the last message. Ignore messages if they are addressed to someone else.`;

export const telegramMessageHandlerTemplate = `# About {{agentName}}:
{{bio}}

# RESPONSE EXAMPLES
{{user1}}: I just saw a really great movie
{{user2}}: Oh? Which movie?
Result: [IGNORE]

{{agentName}}: Oh, this is my favorite scene
{{user1}}: sick
{{user2}}: wait, why is it your favorite scene
Result: [RESPOND]

{{user1}}: stfu bot
Result: [STOP]

{{recentMessages}}

Thread of Tweets You Are Replying To:

{{formattedConversation}}

# INSTRUCTIONS: Choose the option that best describes {{agentName}}'s response to the last message. Ignore messages if they are addressed to someone else.`;
