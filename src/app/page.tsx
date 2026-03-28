'use client';
import { useState, useEffect, useRef } from 'react';

export default function Home() {
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [messages, setMessages] = useState<{ role: 'assistant' | 'user', content: string }[]>([]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [storySetting, setStorySetting] = useState('');
    const [isStarted, setIsStarted] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);

    // 尝试断线重连（仅用于恢复已有会话）
    useEffect(() => {
        async function recoverSession() {
            const savedSessionId = localStorage.getItem('story_session_id');
            if (savedSessionId) {
                try {
                    const debugRes = await fetch(`/api/debug?sessionId=${savedSessionId}`);
                    if (debugRes.ok) {
                        const data = await debugRes.json();
                        if (data.chatHistory && !data.error) {
                            setSessionId(savedSessionId);
                            setMessages(data.chatHistory.map((t: any) => ({
                                role: t.role,
                                content: t.text
                            })));
                            setIsStarted(true);
                            return;
                        }
                    }
                } catch (e) { }
            }
        }
        recoverSession();
    }, []);

    // 自动滚动到最底部
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages]);

    const handleStartStory = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        try {
            const res = await fetch('/api/story/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ storySetting: storySetting.trim() || undefined })
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);

            setSessionId(data.sessionId);
            localStorage.setItem('story_session_id', data.sessionId);
            setMessages([{ role: 'assistant', content: data.firstPrompt }]);
            setIsStarted(true);
        } catch (e) {
            console.error("Initialization failed", e);
            alert("Fate failed to weave the thread: " + e);
        } finally {
            setLoading(false);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!input.trim() || !sessionId || loading) return;

        const userMessage = input.trim();
        setInput('');
        setMessages(prev => [...prev, { role: 'user', content: userMessage }, { role: 'assistant', content: '' }]);
        setLoading(true);

        try {
            const res = await fetch('/api/story/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId, userInput: userMessage }),
            });

            if (!res.body) throw new Error('Stream reading failed');

            const reader = res.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                // 解码一块字节
                const chunk = decoder.decode(value, { stream: true });

                // 将打字机字节拼接到最后一条 assistant 消息里
                setMessages(prev => {
                    const newMsgs = [...prev];
                    const lastIdx = newMsgs.length - 1;
                    // 必须解构深拷贝最后一条消息对象！
                    // 否则 React 18 Strict Mode 检查时运行两遍此函数，会因为上一步引用地址相同而将内容重复叠加两遍（如“你你踏上踏上”）
                    newMsgs[lastIdx] = {
                        ...newMsgs[lastIdx],
                        content: newMsgs[lastIdx].content + chunk
                    };
                    return newMsgs;
                });
            }
        } catch (err) {
            console.error(err);
            setMessages(prev => {
                const newMsgs = [...prev];
                newMsgs[newMsgs.length - 1].content = "Network connection interrupted, the threads of fate have snapped...";
                return newMsgs;
            });
        } finally {
            setLoading(false);
        }
    };

    if (!isStarted) {
        return (
            <div className="min-h-screen bg-[#FDFBF7] text-[#333333] font-serif flex items-center justify-center p-6 bg-[url('https://www.transparenttextures.com/patterns/cream-paper.png')]">
                <div className="w-full max-w-2xl bg-white border border-[#EAE5D9] shadow-2xl rounded-lg p-8 sm:p-12 space-y-8 animate-in fade-in zoom-in duration-700">
                    <div className="text-center space-y-4">
                        <h1 className="text-3xl sm:text-4xl font-bold tracking-[0.4em] text-[#4A4743]">LEGEND BEGINS</h1>
                        <div className="h-1 w-24 bg-[#8D7B68] mx-auto"></div>
                        <p className="text-[#8D7B68] italic">Weave the initial threads of your universe...</p>
                    </div>

                    <form onSubmit={handleStartStory} className="space-y-6">
                        <div className="space-y-2">
                            <label className="block text-sm font-medium text-[#5C554B] tracking-widest uppercase">Story Setting / World Background</label>
                            <textarea
                                className="w-full h-48 bg-[#FAFAF8] border border-[#D8D3C4] focus:border-[#8D7B68] focus:ring-1 focus:ring-[#8D7B68] outline-none p-4 text-lg leading-relaxed placeholder-gray-300 transition-all rounded"
                                placeholder="Enter your story's background, setting, or starting point. If left blank, a default 'post-apocalyptic survival game' setting will be used."
                                value={storySetting}
                                onChange={e => setStorySetting(e.target.value)}
                                disabled={loading}
                            />
                        </div>

                        <button
                            type="submit"
                            disabled={loading}
                            className="w-full py-4 bg-[#4A4743] text-white font-bold tracking-[0.3em] uppercase hover:bg-[#2C2B29] transition-all disabled:opacity-50 shadow-lg active:scale-[0.98]"
                        >
                            {loading ? "INITIALIZING UNIVERSE..." : "IGNITE THE SPARK"}
                        </button>
                    </form>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-[#FDFBF7] text-[#333333] font-serif flex justify-center py-6 sm:py-10 selection:bg-amber-100">
            <div className="w-full max-w-4xl flex flex-col h-[90vh] bg-white border border-[#EAE5D9] shadow-sm rounded-md overflow-hidden">

                {/* 顶部古典标题栏 */}
                <div className="py-5 px-6 border-b border-[#EAE5D9] bg-[#FAFAF8] text-center flex justify-between items-center relative">
                    <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-transparent via-[#D8D3C4] to-transparent opacity-50"></div>
                    <button
                        onClick={() => {
                            if (confirm("Destroy this universe and start anew?")) {
                                localStorage.removeItem('story_session_id');
                                window.location.reload();
                            }
                        }}
                        className="text-xs text-gray-400 hover:text-red-400 transition"
                    >
                        NEW GAME
                    </button>
                    <h1 className="text-xl sm:text-2xl font-bold tracking-[0.3em] text-[#4A4743]">MULTIVERSE STORY</h1>
                    <a
                        href={`/debug${sessionId ? '?sessionId=' + sessionId : ''}`}
                        target="_blank"
                        className="text-xs sm:text-sm text-gray-400 hover:text-[#8D7B68] transition underline decoration-dotted"
                    >
                        Debug Panel
                    </a>
                </div>

                {/* 聊天的舞台 */}
                <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 sm:p-12 space-y-10 scroll-smooth custom-scrollbar">
                    {messages.map((m, i) => (
                        <div key={i} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                            <div
                                className={`max-w-[90%] sm:max-w-[80%] leading-loose tracking-wide sm:text-lg ${m.role === 'user'
                                    ? 'bg-[#F2F0E9] text-[#5C554B] px-6 py-4 rounded-xl rounded-tr-none italic shadow-sm'
                                    : 'text-[#2C2B29]'
                                    }`}
                                style={m.role === 'assistant' ? { textIndent: '2em' } : {}}
                            >
                                {m.content.split('\n').filter(line => line.trim() !== '').map((line, idx) => (
                                    <p key={idx} className="mb-3 last:mb-0 min-h-[1.5rem]">{line}</p>
                                ))}
                            </div>
                        </div>
                    ))}
                    {loading && (
                        <div className="flex items-start text-[#8D7B68] italic tracking-widest text-sm sm:text-base animate-pulse">
                            The scrolls of fate are unfolding...
                        </div>
                    )}
                </div>

                {/* 底部输入框 */}
                <div className="p-4 sm:p-6 bg-[#FAFAF8] border-t border-[#EAE5D9]">
                    <form onSubmit={handleSubmit} className="flex gap-4">
                        <input
                            type="text"
                            className="flex-1 bg-transparent border-b-2 border-[#D8D3C4] focus:border-[#8D7B68] outline-none px-2 py-2 text-lg sm:text-xl placeholder-gray-300 transition-colors"
                            placeholder={loading ? "Calculating, please wait..." : "Where will you go?"}
                            value={input}
                            onChange={e => setInput(e.target.value)}
                            disabled={loading}
                        />
                        <button
                            type="submit"
                            disabled={loading || !input.trim()}
                            className="px-6 py-3 bg-[#FAFAF8] border border-[#D8D3C4] hover:bg-[#F2F0E9] text-[#5C554B] font-medium tracking-widest rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed shadow-sm"
                        >
                            ACTION
                        </button>
                    </form>
                </div>

            </div>
        </div>
    );
}
