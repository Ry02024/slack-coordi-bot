
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { WebClient } from "https://esm.sh/@slack/web-api@6.11.2";

// ------------------- 環境変数設定 -------------------
const SLACK_BOT_TOKEN = Deno.env.get("SLACK_BOT_TOKEN")!;
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;
const ALLOWED_CHANNELS_RAW = Deno.env.get("ALLOWED_CHANNEL_ID") || "";
const ALLOWED_CHANNELS = ALLOWED_CHANNELS_RAW.split(",").map(id => id.trim()).filter(id => id.length > 0);
const slack = new WebClient(SLACK_BOT_TOKEN);

console.log(`Bot started. Allowed Channels: ${ALLOWED_CHANNELS.join(", ")}`);

// チャンネルIDを抽出する正規表現（<#CXXXXXXXXXX|channel_name> または #channel_name 形式に対応）
const CHANNEL_ID_REGEX = /<#([A-Z0-9]+)\|[^>]+>|#([A-Z0-9]+)/;
// ハードコードされた固定の参照チャンネルID（特定のIDで固定したい場合）
const FIXED_REFERENCE_CHANNEL = "C09BL3B8362"; 

// ------------------- メインハンドラ -------------------

serve(async (req) => {
    try {
        const body = await req.json();
        
        if (body.type === "url_verification") {
            return new Response(JSON.stringify({ challenge: body.challenge }), { headers: { "Content-Type": "application/json" } });
        }

        if (body.event && body.event.type === "app_mention" && !body.event.bot_id) {
            const incomingChannel = body.event.channel;

            // 許可チャンネルのチェック
            if (ALLOWED_CHANNELS.length > 0 && !ALLOWED_CHANNELS.includes(incomingChannel)) {
                console.log(`Skip: Channel ${incomingChannel} is not in the allowed list.`);
                return new Response("OK");
            }

            let userQuestion: string = body.event.text;
            // メッセージからメンションを除去
            const originalUserQuestion = userQuestion.replace(/<@U[A-Z0-9]+>\s*/, '').trim();

            // --- 💡 修正 1: 参照チャンネルIDの特定ロジック ---
            let referenceChannelId = incomingChannel; // デフォルトは現在のチャンネル
            let logMessage = `(参照: 現在のチャンネル ${incomingChannel})`;

            const match = originalUserQuestion.match(CHANNEL_ID_REGEX);

            if (match) {
                // チャンネル指定があった場合、そのIDを抽出
                const extractedId = match[1] || match[2];

                if (extractedId) {
                    referenceChannelId = extractedId;
                    logMessage = `(参照: 指定されたチャンネル ${referenceChannelId})`;

                    // 質問文からチャンネル指定の部分を除去
                    userQuestion = originalUserQuestion.replace(CHANNEL_ID_REGEX, '').trim();
                }
            } else if (FIXED_REFERENCE_CHANNEL && incomingChannel !== FIXED_REFERENCE_CHANNEL) {
                // 💡 特定のチャンネルIDが指定されなかったが、常にFIXED_REFERENCE_CHANNELを参照したい場合
                // このロジックはコメントアウトしておき、ユーザーが明示的に指定する場合のみ有効にするのが安全です。
                // referenceChannelId = FIXED_REFERENCE_CHANNEL;
                // logMessage = `(参照: 固定チャンネル ${FIXED_REFERENCE_CHANNEL})`;
            }

            console.log(`処理チャンネル: ${incomingChannel}`);
            console.log(`実際の質問文: ${userQuestion}`);
            console.log(`履歴参照先: ${referenceChannelId}`);
            
            const backgroundTask = async () => {
                try {
                    // --- 💡 修正 2: 履歴取得チャンネルの切り替え ---
                    const history = await slack.conversations.history({ 
                        channel: referenceChannelId, // <--- 参照チャンネルIDを使用
                        limit: 10 // 履歴の取得数
                    });

                    // 履歴を整形 (新しいものから古いものに並び替えて、文脈として使用)
                    const contextText = (history.messages || [])
                        .reverse() 
                        .map((m: any) => `${m.bot_id ? "Model" : "User"}: ${m.text}`)
                        .join("\n");
                    
                    const MODEL_NAME = "gemini-2.5-flash";
                    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${GEMINI_API_KEY}`;
                    
                    // Geminiへのプロンプト作成
                    const fullPrompt = `あなたは優秀なアシスタントです。以下の【履歴】は、参照先チャンネル ${referenceChannelId} の会話履歴です。この履歴を元に、【質問】に正確に答えてください。
[履歴]
${contextText}
[質問]
${userQuestion}`;

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
                    
                    // 回答はメンションされたチャンネルに投稿
                    await slack.chat.postMessage({ channel: incomingChannel, text: answer });
                } catch (err) {
                    console.error("Error in backgroundTask:", err);
                    // エラー発生時は、メンションされたチャンネルにエラーを通知
                    await slack.chat.postMessage({ 
                        channel: incomingChannel, 
                        text: `エラー: 履歴の取得またはAI処理で問題が発生しました。\n${err.message}` 
                    });
                }
            };
            
            // Deno Deploy (Edge Runtime)環境での非同期処理待機
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
