import { open, FileHandle } from "node:fs/promises";
import { type RunEvent, eventToString } from "./events.js";

export class JsonlJournal {
  private filePath: string;
  private handle: FileHandle | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async open(): Promise<void> {
    this.handle = await open(this.filePath, "a");
  }

  async append(event: RunEvent): Promise<void> {
    if (!this.handle) {
      throw new Error("Journal is not open");
    }
    const line = eventToString(event) + "\n";
    await this.handle.write(line);
  }

  async close(): Promise<void> {
    if (this.handle) {
      await this.handle.close();
      this.handle = null;
    }
  }
}
