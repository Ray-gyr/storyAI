'use client';
import { useState } from 'react';

export default function TestLLMPage() {
    const [prompt, setPrompt] = useState('Hello, tell a 50-word micro-sci-fi story.');
    const [response, setResponse] = useState('');
    const [loading, setLoading] = useState(false);
    
    // 耗时状态
    const [ttft, setTtft] = useState<number | null>(null);
    const [totalTime, setTotalTime] = useState<number | null>(null);

    const handleTest = async () => {
        if (!prompt || loading) return;
        setLoading(true);
        setResponse('');
        setTtft(null);
        setTotalTime(null);

        const startTime = Date.now();
        let firstChunkReceived = false;

        try {
            const res = await fetch('/api/test-llm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt }),
            });

            if (!res.body) throw new Error('Stream reading failed');

            const reader = res.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                if (!firstChunkReceived) {
                    setTtft(Date.now() - startTime);
                    firstChunkReceived = true;
                }

                const chunk = decoder.decode(value, { stream: true });
                setResponse(prev => prev + chunk);
            }

            setTotalTime(Date.now() - startTime);

        } catch (error: any) {
            setResponse(prev => prev + '\n[Test Error]: ' + error.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-[#FDFBF7] text-[#333] font-sans p-8">
            <h1 className="text-2xl font-bold mb-6 text-[#4A4743] border-b border-[#D8D3C4] pb-3 tracking-wider">
                Simple Story LLM (storyLLM) Communication Speed Test Panel
            </h1>

            <div className="max-w-3xl bg-white border border-[#EAE5D9] shadow-sm rounded-md p-6">
                <div className="mb-4">
                    <label className="block text-sm font-semibold text-gray-700 mb-2">Test Prompt</label>
                    <textarea 
                        className="w-full border border-gray-300 rounded p-3 bg-[#F9F8F5] resize-none h-24 focus:outline-none focus:border-[#8D7B68]" 
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        disabled={loading}
                    />
                </div>

                <div className="flex items-center gap-4 mb-6">
                    <button 
                        onClick={handleTest}
                        disabled={loading}
                        className="px-6 py-2 bg-[#8D7B68] hover:bg-[#7a6b5a] text-white rounded transition shadow disabled:opacity-50"
                    >
                        {loading ? 'Waiting for response...' : 'Launch Streaming Test'}
                    </button>
                    
                    <div className="flex gap-6 text-sm">
                        <div className="flex flex-col">
                            <span className="text-gray-400">TTFT (Time To First Token)</span>
                            <span className="font-semibold text-lg text-amber-600">
                                {ttft !== null ? `${ttft} ms` : '--'}
                            </span>
                        </div>
                        <div className="flex flex-col">
                            <span className="text-gray-400">Total Time</span>
                            <span className="font-semibold text-lg text-emerald-600">
                                {totalTime !== null ? `${totalTime} ms` : '--'}
                            </span>
                        </div>
                    </div>
                </div>

                <div>
                    <label className="block text-sm font-semibold text-gray-700 mb-2">Response Stream Output</label>
                    <div className="w-full border border-gray-300 rounded p-4 bg-[#F9F8F5] min-h-[200px] whitespace-pre-wrap text-gray-800 leading-relaxed shadow-inner">
                        {response || (loading ? <span className="text-gray-400 animate-pulse">Connecting to LLM...</span> : <span className="text-gray-400">Request not sent yet</span>)}
                    </div>
                </div>
            </div>
        </div>
    );
}
