export default {
  name: "test-plugin",
  version: "1.0.0",
  tools: [
    {
      name: "echo",
      description: "Echoes input back",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      async execute(args) {
        return `echo: ${args.text}`;
      },
    },
  ],
  skills: [
    {
      name: "greet",
      description: "Greets the user",
      async handler(ctx) {
        return `Hello, ${ctx.input || "World"}!`;
      },
    },
  ],
  async init(config) {
    // Plugin initialization — config comes from env vars or defaults
  },
  async destroy() {
    // Cleanup
  },
};
