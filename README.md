# 🤖 Slack Co-ordi Bot

この Bot は、Google の **Gemini API** を利用し、Slack ワークスペース内の会話履歴や添付ファイルを文脈として活用することで、ユーザーの質問に正確かつ文脈に沿って回答する AI アシスタントです。

サーバーレス環境として **Supabase Edge Functions (Deno)** を使用し、GitHub Actions による CI/CD で自動デプロイされます。

## ✨ 主な機能1. **動的な文脈参照（簡易 RAG）**:
* ユーザーが Bot をメンションした際、**メッセージが投稿されたチャンネル**の直近の会話履歴（10件）を自動的に取得し、文脈として Gemini に渡します。


2. **別チャンネル参照**:
* メンション時に `#チャンネルID` を指定することで、**Bot が参加していないチャンネル**の履歴であっても、User Token の権限で取得し、会話の文脈として利用できます。


3. **添付ファイル参照**:
* Bot メンション時に**テキストファイル（スニペット）**が添付されていた場合、そのファイルの内容を読み込み、会話の文脈として使用します。


4. **権限の分離**:
* **Bot Token (`xoxb-`)** はメッセージの投稿のみに使用し、**User Token (`xoxp-`)** を情報収集（履歴、ファイル読み取り）専用に使用することで、Bot の権限を最小限に抑えています。



## 🚀 セットアップ
### ステップ 1: プロジェクトの準備1. **Supabase CLI のインストール**
2. **Supabase プロジェクトの作成**:
```bash
# プロジェクト初期化
supabase init
# Function の作成 (slack-coordi-bot は既に作成済み)
supabase functions new slack-coordi-bot

```


3. **Deno ファイルの配置**:
* `supabase/functions/slack-coordi-bot/index.ts` に最新のロジックを配置します。



### ステップ 2: Slack App の設定とスコープ付与Slack App の管理画面で以下の権限を設定し、App をワークスペースに再インストールしてトークンを取得します。

| トークン | スコープ | 目的 |
| --- | --- | --- |
| **Bot Token (`xoxb-`)** | `chat:write` | メッセージをチャンネルに投稿するため。 |
| **User Token (`xoxp-`)** | `channels:history`, `groups:history`, `files:read` | Bot 不参加チャンネルの履歴取得、およびファイルの読み取りのため。 |

### ステップ 3: 環境変数の設定 (Supabase Secrets)Supabase ダッシュボードの **Edge Functions** > **Secrets** にて、以下の環境変数を設定します。

| 変数名 | 値 |
| --- | --- |
| `SLACK_BOT_TOKEN` | Slack App から取得した **Bot Token (`xoxb-`)** |
| `SLACK_USER_TOKEN` | 履歴とファイル読み取り権限を持つ **User Token (`xoxp-`)** |
| `GEMINI_API_KEY` | Google Gemini API キー |
| `ALLOWED_CHANNEL_ID` | Bot が動作を許可するチャンネル ID (カンマ区切り、任意) |

### ステップ 4: デプロイGitHub Actions を設定している場合、Git にプッシュすることで自動的にデプロイされます。

```bash
git add .
git commit -m "Initial deployment of Slack Co-ordi Bot"
git push origin main

```

## 💡 使用方法Bot が参加しているチャンネルで `@` メンションを付けて質問してください。

| 機能 | 入力例 | 動作 |
| --- | --- | --- |
| **通常会話 (RAG)** | `@bot 今日のタスクの優先順位は？` | **投稿されたチャンネル**の履歴を文脈として回答。 |
| **別チャンネル参照** | `@bot #C09BL3B8362 の件で、あの機能は完了した？` | **`C09BL3B8362` チャンネル**の履歴を文脈として回答。 |
| **ファイル参照** | (テキストファイルを添付) `@bot このドキュメントのサマリーを出力して` | **添付されたファイル**の内容を文脈として回答。 |

---

## 💻 内部構造 (Deno / TypeScript)Bot のロジックは `slack-coordi-bot/index.ts` に集約されています。

* **クライアント**: `botClient` (投稿用) と `userClient` (情報収集用) を分離。
* **文脈決定ロジック**:
1. `body.event.files` が存在するかチェック。-> ファイル取得 (`getFileContent`)。
2. ファイルがない場合、メッセージ内の `#CXXXXXXXXXX` を `CHANNEL_ID_REGEX` で抽出。-> `referenceChannelId` を決定。
3. 決定した `referenceChannelId` を使って `userClient.conversations.history` で履歴を取得。


* **AI処理**: 取得した文脈情報とユーザーの質問をプロンプトに組み込み、Gemini API に渡し、回答を取得します。