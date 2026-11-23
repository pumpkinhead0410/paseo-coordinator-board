# Session coordinator board

The board groups existing Paseo sessions by project and shows which decisions need your attention. A coordinator can review recent conversations, assign work on this host, and report back. The interface supports Korean and English. Open **설정 → 보드 언어 → English** to switch this device to English.

## Install and choose projects

On the computer running your sessions, use **Paseo 0.16.2 or later**. In **Settings → Plugins**, turn on **Enable plugins**, paste this install ID into **Plugin source**, then select **Install plugin**. [Official plugin directory](https://paseo.sh/plugins/devbrother2024/coordinator-board)

```text
devbrother2024/coordinator-board
```

To install from the terminal on that host, run these commands and check that the board is `running`.

```sh
paseo plugin install devbrother2024/coordinator-board
paseo plugin ls coordinator-board
```

For a registry installation, preview a new reviewed release with `paseo plugin update coordinator-board --check`. Run `paseo plugin update coordinator-board` to review and apply the update.

**Git and ZIP installations.** On a host with Git, run `paseo plugin install git:devbrother2024/paseo-coordinator-board --ref main` for the default branch, or replace `main` with `v0.5.12` for the release featured in the video. A full commit SHA also works. For a ZIP, extract the package and run `paseo plugin install .` in the folder containing `paseo-plugin.json`. Keep that folder in place. [Paseo plugin guide](https://paseo.sh/docs/plugins)

Open the board from the sidebar and select the projects you want in your digest. To manage just one session from another project, open **Settings → Link a session from another project**. Search for the session, check its ID and source workspace, select a managed destination, then click **Link to this project**. The card appears once under its destination. The session keeps its original ID, workspace, files and conversation. **Unlink from project** removes the link. The card returns to its source project if that project is also managed.

In **Session progress**, choose **All running** to see running sessions across the selected projects and visible hosts, ordered by recent activity. Each row shows its project and host and opens the corresponding session. Choose **By project** for the kanban layout. Your device remembers the last view.

In the desktop app and on the web, press **⌘+Enter** on Mac or **Ctrl+Enter** on Windows and Linux to send from the current request, reply or question field. **Enter** inserts a line break. Hover over the send button or focus it with Tab to see the shortcut for your device.

**My decisions** shows overdue and urgent items first, followed by work waiting for a response or permission. Other items are ordered by deadline. Within a priority, the oldest known wait comes first. A card stays in place while you compose a reply or review a merge. Questions and explanations preserve line breaks and render Markdown lists, links, and inline code.

After sending an answer, choose **Open receiving session** on the collapsed card to check the conversation. Expand **Recent decision activity** below **My decisions** for the exact message, time and recipient. When available, the history also links to the session that asked the question. An answer saved only on the board can link to its original session without implying delivery. The project’s **Decision follow-up** column keeps the same record. Device-wide actions appear under **Host-wide**. A verified follow-up appears on the card, and the recipient chip opens the conversation.

## Work with a coordinator

Use **Expand editor** next to **Request for the coordinator** to review a longer draft. Collapsing and reopening the editor preserves your text and photos.

Click **Start with recommended settings** to create the coordinator, or select **Choose an existing coordinator session** in Settings. Before creating or replacing a coordinator, the board shows the model and tool permission mode. It prefers Auto mode for Claude Code and Auto-review for Codex when supported. OpenCode with Build mode and Copilot with Agent mode can serve as alternatives when their coordinator mode is available on the host. For other providers, you can designate an existing session with Paseo MCP.

Paseo pins a new coordinator workspace in the host’s sidebar by default. Turn this off in **Settings → Sidebar pinning**. Replacing the coordinator in the same workspace preserves its existing pin state. For an existing coordinator, click **Pin current coordinator workspace**.

On desktop or web, drop photos onto the coordinator request field or a decision reply, paste a screenshot, or choose the paperclip labeled **Add attachment**. Review the images, remove any you do not want to share, then choose **Send to coordinator**. You can send images with or without text. Attach up to four PNG, JPEG, or WebP images, up to 5 MiB each and 12 MiB combined. If a file cannot be read, choose it again or dismiss the failed attachment before sending. Open the receiving session to see photos sent with a new request, reply, or question. Select a photo to enlarge it. The host keeps original images for the most recent 20 photo messages. On the native mobile app, open the coordinator session and attach photos in its conversation composer.

Use **Send to coordinator** to delegate work. **Request digest** asks the designated session to inspect the latest excerpts and record which decisions need a person. The board displays that evidence and refreshes while open. A new message can invalidate the coordinator's earlier judgment.

Each session decision has an **Assigned session** chip beside the project and session name. It opens the original conversation without sending a reply. The card leads with the question and one suggested reply. Open **View source** for the original text and the reason behind the suggestion. Use **Ask coordinator for a recommendation** to revisit an older card. If a necessary detail is missing, the card asks for that detail. Choose options directly on the card. When no suggested reply is available, type your own. Open evidence and history for context.

A worker asking “Which project does this session belong to?” can receive a verified answer from the designated coordinator during a requested digest. The project card shows a record of the response. **Settings → Automatic replies to factual questions** lets you turn this off for the host. Receiving a reply can start the worker's model and use its provider allowance. A decision such as deleting a work folder still requires the person responsible.

- **Reply to a session.** Each decision has its own card. Edit the suggested reply in the input, or choose an option. Expand a long reply to review it. Press the send button below the input to send the displayed text to the named recipient.
- **Ask for clarification.** Use **Ask a question** to send a question to the assigned session. To coordinate across tasks, choose **Ask coordinator to coordinate**, review the recipient, then use **Send request to coordinator**.
- **Respond to a native approval.** Choose **Assigned session** to open Paseo's permission or plan dialog. A delivery receipt confirms that the session received your message. Verify the result before recording completion.

On ledger cards, **Operating coordinator** opens the session that will receive the answer. **Source work session** opens the originating conversation when available. An active Claude or Codex coordinator can take replies from several cards in its current turn. If the recipient is waiting for permission or the assigned worker is busy, the board saves each reply and its photos until the session is ready. You can cancel a queued reply on its card.

Decision replies include the original project, session when known, card, question, and revision alongside the answer. A saved local reply can retain photos. Personal checks have a **I checked this** checkbox. During a digest, the coordinator can archive a verified merge-only record or a completed source-session check. After you send a reply, mark a decision as reviewed, or merge a PR, the result stays where you acted in **My decisions**. You can dismiss it when you are ready. Open **Recent decision activity** to look up the result later.

Open Settings to compare remaining quota bars and reset times by account. Credits without a reported limit show a balance. A host can supply dated, display-only readings for providers missing usage through an optional account-usage.json file. Grades without a saved order are routed by the host's local profile selector (`paseo/profile_selector.py`), which reads the shared quota record and spreads work across four quota pools. The board refreshes that record once when the coordinator plans an assignment. An explicitly saved model order takes precedence.

## GitHub pull requests

The sidebar count combines session questions, pull requests ready for review, and decisions from configured project records. Entries referring to the same pull request or verified session question appear together. A pull request shared by several managed projects counts once. Choose **Merge on board** to review the repository, branches, commit, and allowed merge methods. Confirm to merge with the host’s authenticated GitHub account. Select the underlined repository and PR number at the top of the card to read the diff on GitHub. A changed commit or failed requirement requires another review. Drafts and pull requests waiting for checks appear in project progress. The board reads open pull requests with the host’s authenticated GitHub CLI. In **Settings → GitHub repositories by project**, choose automatic detection, enter an explicit repository, or turn off lookup for a project.

When GitHub confirms a merge performed on the board, the board sends the PR link and the available merge commit to the responsible coordinator. This can start a model turn to assess follow-up work. The board queues the notification while the recipient is busy and shows delivery status separately from the merge result. Viewing a PR that was already merged does not start a turn.

## Models, hosts and tools

In **Settings**, choose providers and models for task grades A through D, or the M grade used to create or replace the coordinator. Providers discovered on the active host are included by default. You can exclude a provider and restore it later. The model selector shows eligible providers, available models, and reasons a saved model cannot be used. The current route appears first and preselects its model and effort, with the selector's reason or the reason a grade is held. Grades map to selector roles as A=deep·xhigh, B=deep·high, C=work·high, D=work·medium, M=deep·high. If the selector is missing or defers, the grade is held instead of falling back to a built-in table. If a saved list has no available candidate, edit it or choose **Restore selector routing**. Session cards show the provider and model reported by Paseo. Under **Settings → Paseo hosts**, each device shows its connection and whether its sessions appear in the list. Use **Hide** or **Show** to change visibility. The coordinator creates workers on its own host. To assign Windows work on a Windows machine, send the request from that host’s board.

The coordinator uses `read_board_conversation` to read managed sessions and `classify_board_conversation` to record a judgment tied to the current evidence. It uses `plan_board_assignment` and `assign_board_worker` to delegate work. A worker with reporting enabled can post a question or a result to its own card with `report_to_board`. These tools require Paseo MCP integration in the session's provider.

The host stores project selections, session links, judgments, delivery receipts and notes in its local plugin data. Opening the board does not start a model. When you send a message, the receiving session uses its provider under your existing plan. [한국어 사용 안내](README.md) · [MIT license](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)


## Kanban and decision records

Project progress shows occupied lanes side by side on desktop and stacked on a phone. Session rows show their execution host. Connected, visible remote hosts can show running sessions when their project ID or repository identifies a managed project. Opening a remote session takes you to that host.

Project owners can supply independent records in `tracked-decisions.json` in the plugin data directory, or link existing project ledgers through `tracked-sources.json`. This retains manual checks, multiple questions tied to one session, and release decisions that include a second question. Recording a choice closes that version of the record. Sending a message and confirming a GitHub merge are separate actions. [Configuration example](README.md#프로젝트별-칸반과-결정-원장)

Use the project buttons directly under the board title to filter pending decisions, recent activity, and project progress together. Select multiple names, press a selected name to remove it, or choose **All** to reset. Counts show pending decisions. Shared pull requests count once. A merge decision retains its GitHub link after the PR closes. A follow-up question on a merged PR sends only the answer to that question. A verified workspace match adds a session chip with its host and status to the PR card. Open **Operating coordinator** to visit the session that owns a ledger card, including from its collapsed project preview. If a separate source work session is available, you can open that conversation too. For a tracked decision, select the named recipient to send your answer or choose **Save answer on board and close** to keep a local record.

Before deciding, select **Ask a question** on the card. Check the recipient, write a question or attach a screenshot, then select **Send question**. The card stays open and shows the exchange under **Questions and answers**.
