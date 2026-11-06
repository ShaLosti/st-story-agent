# Lore Agent

A SillyTavern extension and server plugin that gives the main model a persistent memory entry in the character lorebook. The model writes short `<lore_edits>` instructions at the end of its reply, and a [pi](https://github.com/earendil-works/pi) agent applies them to the **📒 Story State** entry before the next generation. You decide what the entry keeps.

## Why it's helpful

- It saves money on the main model's output. Instead of repeating the inventory or other information every turn, the main model writes only the edits, and the information stays correct across the whole play.
- A separate model (pi) applies the edits, so the main model can focus on the story.

## Dependencies

- SillyTavern with the Chat Completion API. Group chats are not supported.
- Node.js 22.19 or newer, which pi needs.
- [pi coding agent](https://github.com/earendil-works/pi), with a model provider connected.
- A lorebook linked to the character.

## Installation

1. Install pi and connect a provider:
   ```sh
   npm install -g --ignore-scripts @earendil-works/pi-coding-agent
   pi
   ```
   In pi, run `/login`.
2. Turn on server plugins in `SillyTavern/config.yaml`:
   ```yaml
   enableServerPlugins: true
   ```
3. Install the extension: paste this URL into SillyTavern's **Install Extension** dialog:
   ```text
   https://github.com/ShaLosti/st-story-agent
   ```
4. Copy `server/index.js` from this repo to `SillyTavern/plugins/lore-agent/index.js`, then restart SillyTavern.
5. Import the prompt: in the **Prompt Manager**, click **Import** and choose `setup/lore-edits-prompt.json`. Add **📝 Lore Edits (agent)** to the prompt list and turn it on. Replace `[Section]: [what it keeps]` with the sections you want in the entry.
6. Import the regex: in **Regex**, import `setup/lore-edits-regex.json`. It hides `<lore_edits>` in the chat and strips it from the prompt.
7. In **Extensions → 📒 Lore Agent**, set the pi model (`provider/model`), thinking level and timeout.

If the plugin cannot find pi, set the `LORE_AGENT_PI_CLI` environment variable to the path of pi's `cli.js`.

## How it works

1. The **📝 Lore Edits (agent)** prompt tells the main model which sections the entry keeps. When something changes, the model ends its reply with instructions inside `<lore_edits>`.
2. When the next generation starts (send, swipe, regenerate or continue), the extension sends the current entry and those instructions to the server plugin.
3. The plugin runs pi with only its read and edit tools on a copy of the entry (`worlds/_lore-agent/<lorebook>/story_state.md`) and returns the edited text.
4. The extension writes the text into the **📒 Story State** entry, and then the main model generates. The entry is created automatically as a constant entry at depth 1.
5. Each reply stores the state from before and after it, so swipes, deletes and edits restore the correct state. The state is kept per chat, and manual edits of the entry are preserved.
6. If the agent fails, you can retry, skip the edit or stop the generation.

The extension runs only while the **📝 Lore Edits (agent)** toggle is on. Its settings let you edit the system prompt and task that pi receives. **Preview next prompt** and **Show last sent** show exactly what pi gets.
