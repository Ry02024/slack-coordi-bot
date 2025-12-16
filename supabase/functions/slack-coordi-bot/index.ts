
// supabase/functions/slack-coordi-bot/index.ts (完全 User Token 参照版)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { WebClient } from "https://esm.sh/@slack/web-api@6.11.2";

// ------------------- 環境変数設定 -------------------
// 🤖 Bot Token: メッセージの投稿に使用 (xoxb-)
const SLACK_BOT_TOKEN = Deno.env.get("SLACK_BOT_TOKEN")!;

// 👤 User Token: ファイル読み取り & 履歴取得に使用 (xoxp-)
const SLACK_USER_TOKEN = Deno.env.get("SLACK_USER_TOKEN")!;

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;
const ALLOWED_CHANNELS_RAW = Deno.env.get("ALLOWED_CHANNEL_ID") || "";
const ALLOWED_CHANNELS = ALLOWED_CHANNELS_RAW.split(",").map(id => id.trim()).filter(id => id.length > 0);

// Bot操作用クライアント (発言用)
const botClient = new WebClient(SLACK_BOT_TOKEN);
// User操作用クライアント (情報収集用)
const userClient = new WebClient(SLACK_USER_TOKEN);

console.log(`Bot started.`);

// ------------------- ヘルパー関数: ファイル内容の取得 -------------------

async function getFileContent(fileId: string): Promise<string> {
    try {
        // User Tokenを使ってファイル情報を取得
        const fileInfoResponse = await userClient.files.info({ file: fileId });
        const file = fileInfoResponse.file as any;

        if (!file || file.mode !== 'snippet') {
            return `(Warning: ファイル ${file?.name} はテキスト形式(スニペット)ではないためスキップしました。)`;
        }

        const downloadUrl = file.url_private;
        
        const response = await fetch(downloadUrl, {
            headers: {
                'Authorization': `Bearer ${SLACK_USER_TOKEN}`
            }
        });

        if (!response.ok) {
            throw new Error(`ファイルダウンロードエラー: ${response.statusText}`);
        }
        
        return await response.text();

    } catch (error) {
        console.error("ファイル取得エラー:", error);
        return `(Error: ファイルID ${fileId} の内容取得に失敗しました。)`;
    }
}

// ------------------- メインハンドラ -------------------

serve(async (req) => {
    try {
        const body = await req.json();
        
        if (body.type === "url_verification") {
            return new Response(JSON.stringify({ challenge: body.challenge }), { headers: { "Content-Type": "application/json" } });
        }

        if (body.event && body.event.type === "app_mention" && !body.event.bot_id) {
            const incomingChannel = body.event.channel;

            if (ALLOWED_CHANNELS.length > 0 && !ALLOWED_CHANNELS.includes(incomingChannel)) {
                return new Response("OK");
            }

            let userQuestion: string = body.event.text;
            const originalUserQuestion = userQuestion.replace(/<@U[A-Z0-9]+>\s*/, '').trim();
            
            let context = '';
            let source = '';
            
            // 1. ファイルが添付されているかチェック
            if (body.event.files && body.event.files.length > 0) {
                const fileId = body.event.files[0].id;
                context = await getFileContent(fileId);
                source = '添付ファイル(User Token)';
            } else {
                // 2. ファイルがない場合は履歴を取得
                // 💡 修正: User Token (userClient) を使って履歴を取得
                // これにより、Botが参加していないチャンネルでもUserが見える範囲なら取得可能
                try {
                    const historyResponse = await userClient.conversations.history({ 
                        channel: incomingChannel, 
                        limit: 10 
                    });
                    context = (historyResponse.messages || [])
                        .reverse() 
                        .map((m: any) => `${m.user ? 'User' : 'Bot'}: ${m.text}`)
                        .join("\n");
                    source = 'チャンネル履歴(User Token)';
                } catch (e) {
                    console.log("履歴取得失敗:", e);
                    context = "(履歴を取得できませんでした。User Tokenの権限またはチャンネルIDを確認してください)";
                }
            }

            console.log(`コンテキストソース: ${source}`);
            
            const backgroundTask = async () => {
                try {
                    const MODEL_NAME = "gemini-2.5-flash";
                    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`;
                    
                    const fullPrompt = `あなたは優秀なAIアシスタントです。ユーザーの【質問】に答えてください。
                    質問に答えるために、以下の【文脈情報】を参照してください。

[文脈情報]
${context}
[質問]
${originalUserQuestion}`;

                    const response = await fetch(apiUrl, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            contents: [{ parts: [{ text: fullPrompt }] }]
                        })
                    });

                    if (!response.ok) { throw new Error(`Gemini API Error: ${await response.text()}`); }
                    
                    const data = await response.json();
                    const answer = data.candidates?.[0]?.content?.parts?.[0]?.text || "回答生成エラー";
                    
                    // 返信は Bot Token で行う
                    await botClient.chat.postMessage({ channel: incomingChannel, text: answer });
                } catch (err) {
                    console.error("Error in backgroundTask:", err);
                    await botClient.chat.postMessage({ 
                        channel: incomingChannel, 
                        text: `エラー: AI処理で問題が発生しました。\n${err.message}` 
                    });
                }
            };
            
            if (typeof EdgeRuntime !== "undefined") { 
                EdgeRuntime.waitUntil(backgroundTask()); 
            } else { 
                await backgroundTask(); 
            }
        }
        return new Response("OK", { status: 200 });
    } catch (error) {
        console.error("Global Error:", error);
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
});
