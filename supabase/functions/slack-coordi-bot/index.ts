
import { serve } from 'https://deno.land/std/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { generateGeminiResponse } from '../_shared/gemini.ts';

// ------------------- 環境変数設定 -------------------
// Supabase Secretsで設定されていることを前提とします
const SLACK_BOT_TOKEN = Deno.env.get('SLACK_BOT_TOKEN') || '';
const ALLOWED_CHANNEL_ID = Deno.env.get('ALLOWED_CHANNEL_ID');
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') || '';

const supabaseClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
);

// チャンネルIDを抽出する正規表現（<#CXXXXXXXXXX|channel_name> または #channel_name 形式に対応）
const CHANNEL_ID_REGEX = /<#([A-Z0-9]+)\|[^>]+>|#([A-Z0-9]+)/;

// ------------------- Slack API 処理 -------------------

async function postSlackMessage(channel: string, text: string) {
    await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
        },
        body: JSON.stringify({
            channel: channel,
            text: text,
        }),
    });
}

// ------------------- メインハンドラ -------------------

serve(async (req) => {
    // 省略: Slack Challenge 認証 (前回成功しているため)
    // ...

    const body = await req.json();
    const event = body.event;

    if (event && event.type === 'app_mention') {
        const userText: string = event.text.replace(/<@U[A-Z0-9]+>\s*/, '').trim(); // Botメンションを除去
        const currentChannel: string = event.channel;

        // --- 参照チャンネルIDの特定ロジック ---
        let referenceChannelId = currentChannel;
        let queryText = userText;
        let logMessage = `(現在のチャンネル: ${currentChannel})`;

        const match = userText.match(CHANNEL_ID_REGEX);

        if (match) {
            // チャンネルリンクまたはハッシュタグ形式でIDが抽出できた場合
            // マッチグループ1 (リンク形式) または マッチグループ2 (ハッシュタグ形式) のいずれかがID
            const extractedId = match[1] || match[2];

            if (extractedId) {
                // 抽出したIDを参照チャンネルとして設定
                referenceChannelId = extractedId;
                logMessage = `(参照チャンネルとして ${referenceChannelId} を指定)`;
                
                // 抽出したチャンネルID部分をクエリテキストから除去
                queryText = userText.replace(CHANNEL_ID_REGEX, '').trim();
            }
        }
        
        console.log(`ユーザーのクエリ: ${queryText} ${logMessage}`);


        // --- Geminiへのプロンプト作成 ---
        // RAGをスキップし、参照チャンネルIDを情報としてプロンプトに含める
        const systemInstruction = `あなたは優秀なAIアシスタントです。ユーザーの質問に親切かつ正確に答えてください。
        (RAG機能が未実装のため、以下の情報は無視して回答を生成してください。
        ただし、将来的に ${referenceChannelId} チャンネルの履歴を参照する意図があることを理解して回答してください。)`;

        // Gemini応答生成
        const response = await generateGeminiResponse(GEMINI_API_KEY, systemInstruction, queryText);

        // Slackへ応答
        await postSlackMessage(currentChannel, response);
    }

    return new Response('OK', { status: 200 });
});
