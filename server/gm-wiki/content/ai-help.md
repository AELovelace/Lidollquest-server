# Ask the GM wiki assistant

[Wiki home](index.md)

## Open a help window

1. Sign in to the web **GM panel** with your staff account.
2. Open **Story Workshop** and choose **Ask the GM wiki assistant** in the top toolbar. The same link is available in the GM panel.
3. A separate chat window opens so you can keep your quest canvas visible. If your browser blocks pop-ups, use the ordinary link or open it in a new tab. The direct path is `/gm/help` on your game server.
4. Wait for **Ready**, then choose an example question or type your own. Click **Ask the assistant**, or press Ctrl+Enter (Command+Enter on macOS).

The packaged Python editor also offers **GM wiki assistant** alongside its Online Story Workshop launcher. Enter the public GM panel address ending in `/gm`, then sign in in the browser if necessary.

This is a handbook assistant for online GM tools. It explains the documented workflow; it does not inspect your open flow, read unpublished drafts, or make changes for you.

## Ask a useful question

Include the control or block name, what you want the player to do, and where you are stuck. For example:

- “How do I make three quests unlock in order, with a separate reward for each?”
- “How do I check piety before accepting a quest? Show the relevant pictures.”
- “I saved my NPC and quest drafts. What do I need to publish before placing the NPC?”
- “How does a zone timer count time when the player leaves and comes back?”

Follow up naturally: “Which output connects to the refusal dialogue?” The assistant receives up to six recent messages from this window. Each question is grounded in matching sections of the GM wiki. If it cannot find enough documentation, it should ask you for a more specific question.

## Read sources and pictures

Answers refer to numbered sources such as **[1]**. Expand the matching source below the answer, then choose **Read this wiki section** to open the documented steps. Sources come from retrieved handbook sections; an AI answer can still misunderstand them, so check the original before publishing.

When a retrieved section includes a screenshot, its source card displays the picture and its authored caption. Click the picture to enlarge it, choose **Open full-size image** for the original, or press Escape to close the viewer. Pictures come from the same wiki as the editor documentation; the assistant does not take screenshots of your current work.

The model selects text using headings, section content and captions. It does not interpret the image pixels. If the picture you need is in a different section, ask about that specific editor control or open the linked chapter. A text-only section will not have a picture card.

## Start over and keep conversations separate

**New chat** clears the conversation and cancels a pending response in this window. Reloading or closing the window clears its history too. After 30 minutes without an answer, the window clears the conversation automatically. Changing or removing the staff sign-in in another tab also clears it.

Chat is kept in this tab's memory, not saved with your quest. Only your question, recent chat messages and matching documentation are sent to the AI service. Do not paste credentials or private player records into a question. Every question requires a current gamemaster role.

## When help is unavailable

| Message or symptom | What to do |
| --- | --- |
| Sign in using Staff sign-in | Open that link, complete staff sign-in, and return to the chat. If needed, reload. |
| GM help is not configured | Ask the server operator to configure the GM help URL and service key. Ordinary authoring and the handbook still work. |
| The assistant is busy | Wait for your current question to finish, or try again shortly. Each account can have one question in flight. |
| The answer model is unavailable | Retrieval succeeded; open the displayed wiki sources and pictures for the steps. |
| The help service could not answer | Retry once. The operator should check port 9093, the service key, and the game server's connection to the AI server. |
| Answers describe old tools | The operator needs to refresh the separate GM wiki index. Its timestamp is shown after an answer. |

The network path is **your browser → game server → GM RAG service**. The game server forwards replies back to your browser. The AI server's public-IP restriction therefore applies to the game server's outgoing connection, not to your computer or phone. Pictures also load from the game server. No direct AI-server access is needed on your device.

Use the [publishing reference](publishing.md), [quest reference](quests.md), or [troubleshooting recipes](troubleshooting.md) whenever you want to read the original instructions directly.
