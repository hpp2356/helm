export default {
  name: "analyze",
  description: "Analyze current conversation",
  handler: async (input, ctx) => {
    return `Conversation has ${ctx.messages.length} messages. Input: "${input}"`;
  },
};
