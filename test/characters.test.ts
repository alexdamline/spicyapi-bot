import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildMessages, Conversations, parseCharacters, trimHistory, type ChatMessage } from "../src/core/characters.js";

describe("parseCharacters", () => {
  it("loads the bundled example file", () => {
    const characters = parseCharacters(JSON.parse(readFileSync("characters/default.json", "utf8")));
    expect(characters.map((item) => item.id)).toEqual(["mira", "theo"]);
    expect(characters[0]?.greeting).toContain("{{user}}");
  });

  it("accepts the bot's own shape, a bare array or a single object", () => {
    const one = { name: "Ada", system: "You are Ada.", model: "example/chat-model/chat" };
    expect(parseCharacters({ characters: [one] })[0]).toEqual({ id: "ada", name: "Ada", system: "You are Ada.", model: "example/chat-model/chat" });
    expect(parseCharacters([one])).toHaveLength(1);
    expect(parseCharacters(one)).toHaveLength(1);
  });

  it("turns a Character Card V2 into one system message", () => {
    const [card] = parseCharacters({
      spec: "chara_card_v2",
      data: {
        name: "Captain Vale",
        description: "A retired sky pirate.",
        personality: "Gruff, loyal.",
        scenario: "A storm grounds the airship.",
        first_mes: "Hold on to something, {{user}}.",
        mes_example: "<START>\n{{char}}: Aye.",
      },
    });
    expect(card?.id).toBe("captain-vale");
    expect(card?.greeting).toBe("Hold on to something, {{user}}.");
    expect(card?.system).toContain("A retired sky pirate.");
    expect(card?.system).toContain("Scenario:\nA storm grounds the airship.");
  });

  it("rejects files a person would want to hear about", () => {
    expect(() => parseCharacters({ characters: [] })).toThrow(/no characters/);
    expect(() => parseCharacters([{ name: "A", system: "" }])).toThrow(/empty system prompt/);
    expect(() => parseCharacters([{ system: "x" }])).toThrow(/no name/);
    expect(() =>
      parseCharacters([
        { name: "Sam", system: "a" },
        { name: "Sam", system: "b" },
      ]),
    ).toThrow(/share the id/);
  });
});

describe("conversation history", () => {
  const turn = (n: number): ChatMessage[] => [
    { role: "user", content: `u${n}` },
    { role: "assistant", content: `a${n}` },
  ];

  it("keeps the newest turns and always starts with the person", () => {
    const history = [...turn(1), ...turn(2), ...turn(3)];
    expect(trimHistory(history, 2).map((m) => m.content)).toEqual(["u2", "a2", "u3", "a3"]);
    expect(trimHistory([{ role: "assistant", content: "x" }, ...turn(1), ...turn(2)], 2).map((m) => m.content)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("puts the system prompt and greeting first and fills placeholders", () => {
    const character = { id: "c", name: "Mira", system: "You are {{char}} talking to {{user}}.", greeting: "Hi {{user}}!" };
    const messages = buildMessages(character, turn(1), "Sam");
    expect(messages[0]).toEqual({ role: "system", content: "You are Mira talking to Sam." });
    expect(messages[1]).toEqual({ role: "assistant", content: "Hi Sam!" });
    expect(messages.slice(2)).toEqual(turn(1));
  });

  it("separates conversations by key and character, trims, and forgets idle ones", () => {
    const clock = { t: 0 };
    const store = new Conversations(2, 1000, () => clock.t);
    store.append("a", "mira", "u1", "a1");
    store.append("a", "mira", "u2", "a2");
    store.append("a", "mira", "u3", "a3");
    expect(store.history("a", "mira").map((m) => m.content)).toEqual(["u2", "a2", "u3", "a3"]);
    expect(store.history("a", "theo")).toEqual([]);
    expect(store.history("b", "mira")).toEqual([]);
    store.reset("a");
    expect(store.isNew("a", "mira")).toBe(true);
    store.append("a", "mira", "u", "a");
    clock.t = 5000;
    expect(store.history("a", "mira")).toEqual([]);
  });
});
