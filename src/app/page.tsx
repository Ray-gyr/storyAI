'use client';
import { useState, useEffect, useRef } from 'react';

export interface SessionMeta {
    id: string;
    title: string;
    style: string;
}

export default function Home() {
    // 状态管理
    const [savedSessions, setSavedSessions] = useState<SessionMeta[]>([]);
    const [openTabs, setOpenTabs] = useState<SessionMeta[]>([]);
    const [currentView, setCurrentView] = useState<'home' | 'intro' | 'chat' | 'new_story'>('home');
    const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
    const [isClient, setIsClient] = useState(false);

    // Chat 状态与前端缓存
    const [messages, setMessages] = useState<{ role: 'assistant' | 'user', content: string }[]>([]);
    const [chatCache, setChatCache] = useState<Record<string, { role: 'assistant' | 'user', content: string }[]>>({});
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [storySetting, setStorySetting] = useState('');
    const scrollRef = useRef<HTMLDivElement>(null);

    // 初始加载历史
    useEffect(() => {
        setIsClient(true);
        const stored = localStorage.getItem('story_sessions');
        if (stored) {
            try {
                const parsed = JSON.parse(stored);
                if (Array.isArray(parsed)) {
                    setSavedSessions(parsed.map((item: any) =>
                        typeof item === 'string' ? { id: item, title: item.substring(item.length - 6), style: "UNKNOWN" } : item
                    ));
                }
            } catch (e) { }
        } else {
            // Backward compatibility
            const oldSession = localStorage.getItem('story_session_id');
            if (oldSession) {
                const legacy = { id: oldSession, title: oldSession.substring(oldSession.length - 6), style: "UNKNOWN" };
                setSavedSessions([legacy]);
                localStorage.setItem('story_sessions', JSON.stringify([legacy]));
            }
        }

        const storedTabs = localStorage.getItem('story_open_tabs');
        if (storedTabs) {
            try {
                const parsed = JSON.parse(storedTabs);
                if (Array.isArray(parsed)) {
                    setOpenTabs(parsed.map((item: any) =>
                        typeof item === 'string' ? { id: item, title: item.substring(item.length - 6), style: "UNKNOWN" } : item
                    ));
                }
            } catch (e) { }
        }
    }, []);

    const addOpenTab = (meta: SessionMeta) => {
        setOpenTabs(prev => {
            const next = [...prev.filter(t => t.id !== meta.id), meta];
            localStorage.setItem('story_open_tabs', JSON.stringify(next));
            return next;
        });
    };

    const handleCloseTab = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        setOpenTabs(prev => {
            const next = prev.filter(t => t.id !== id);
            localStorage.setItem('story_open_tabs', JSON.stringify(next));
            return next;
        });
        if (activeSessionId === id && currentView === 'chat') {
            setActiveSessionId(null);
            setCurrentView('home');
        }
    };

    // 同步当前聊天记录到前端缓存 (0ms 切换)
    useEffect(() => {
        if (activeSessionId && messages.length > 0) {
            setChatCache(prev => ({ ...prev, [activeSessionId]: messages }));
        }
    }, [messages, activeSessionId]);

    // 自动滚动
    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages]);

    const loadSessionChat = async (sessionId: string, forceRefresh = false) => {
        // 如果前端已经缓存了该世界的聊天记录，直接 0ms 无缝切入
        if (!forceRefresh && chatCache[sessionId]) {
            setActiveSessionId(sessionId);
            setMessages(chatCache[sessionId]);
            const meta = savedSessions.find(s => s.id === sessionId) || { id: sessionId, title: sessionId.slice(-6), style: "UNKNOWN" };
            addOpenTab(meta);
            setCurrentView('chat');
            return;
        }

        setLoading(true);
        try {
            const debugRes = await fetch(`/api/story/load?sessionId=${sessionId}`);
            if (debugRes.ok) {
                const data = await debugRes.json();
                if (data.chatHistory && !data.error) {
                    setActiveSessionId(sessionId);
                    setMessages(data.chatHistory.map((t: any) => ({
                        role: t.role,
                        content: t.text
                    })));
                    const existingMeta = savedSessions.find(s => s.id === sessionId);
                    const meta: SessionMeta = {
                        id: sessionId,
                        title: data.metadata?.title || existingMeta?.title || sessionId.slice(-6),
                        style: data.metadata?.style || existingMeta?.style || "UNKNOWN"
                    };
                    addOpenTab(meta);
                    setCurrentView('chat');
                } else {
                    alert("存档已损坏或过期");
                }
            } else if (debugRes.status === 404) {
                alert("该存档（旧版本内存记录）在云端数据库中不存在，请点击卡片右下角的 [DESTROY] 彻底删除这层旧维度的残留！");
            } else {
                alert(`获取云端存档失败 (HTTP ${debugRes.status})，可能是环境变量或 Redis 配置问题。`);
            }
        } catch (e) {
            alert("读取存档网络失败");
        } finally {
            setLoading(false);
        }
    };

    const handleStartDefaultStory = async (e: React.MouseEvent) => {
        e.preventDefault();
        setLoading(true);
        try {
            const res = await fetch('/api/story/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}) // Backend will naturally default to the apocalypse setting
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);

            const meta: SessionMeta = {
                id: data.sessionId,
                title: data.metadata?.title || data.sessionId.slice(-6),
                style: data.metadata?.style || "UNKNOWN"
            };
            const updatedSessions = [...savedSessions, meta].slice(0, 3);
            setSavedSessions(updatedSessions);
            localStorage.setItem('story_sessions', JSON.stringify(updatedSessions));

            addOpenTab(meta);
            setActiveSessionId(meta.id);
            setMessages([{ role: 'assistant', content: data.firstPrompt }]);
            setCurrentView('chat');
        } catch (err: any) {
            alert("Fate failed to weave the thread: " + err.message);
        } finally {
            setLoading(false);
        }
    };

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

            const meta: SessionMeta = {
                id: data.sessionId,
                title: data.metadata?.title || data.sessionId.slice(-6),
                style: data.metadata?.style || "UNKNOWN"
            };
            const updatedSessions = [...savedSessions, meta].slice(0, 3);
            setSavedSessions(updatedSessions);
            localStorage.setItem('story_sessions', JSON.stringify(updatedSessions));

            addOpenTab(meta);
            setActiveSessionId(meta.id);
            setMessages([{ role: 'assistant', content: data.firstPrompt }]);
            setCurrentView('chat');
            setStorySetting('');
        } catch (e: any) {
            alert("Fate failed to weave the thread: " + e.message);
        } finally {
            setLoading(false);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!input.trim() || !activeSessionId || loading) return;

        const userMessage = input.trim();
        setInput('');
        setMessages(prev => [...prev, { role: 'user', content: userMessage }, { role: 'assistant', content: '' }]);
        setLoading(true);

        try {
            const res = await fetch('/api/story/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: activeSessionId, userInput: userMessage }),
            });

            if (!res.body) throw new Error('Stream reading failed');

            const reader = res.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value, { stream: true });

                setMessages(prev => {
                    const newMsgs = [...prev];
                    const lastIdx = newMsgs.length - 1;
                    newMsgs[lastIdx] = {
                        ...newMsgs[lastIdx],
                        content: newMsgs[lastIdx].content + chunk
                    };
                    return newMsgs;
                });
            }
        } catch (err) {
            setMessages(prev => {
                const newMsgs = [...prev];
                newMsgs[newMsgs.length - 1].content = "Network connection interrupted...";
                return newMsgs;
            });
        } finally {
            setLoading(false);
        }
    };

    const handleDeleteSession = (idToDelete: string, e: React.MouseEvent) => {
        e.stopPropagation();
        if (confirm("确定要删除这个世界吗？这将彻底从云端擦除数据！")) {
            const updated = savedSessions.filter(s => s.id !== idToDelete);
            setSavedSessions(updated);
            localStorage.setItem('story_sessions', JSON.stringify(updated));

            setOpenTabs(prev => {
                const next = prev.filter(t => t.id !== idToDelete);
                localStorage.setItem('story_open_tabs', JSON.stringify(next));
                return next;
            });

            if (activeSessionId === idToDelete) {
                setActiveSessionId(null);
                setCurrentView('home');
            }
        }
    };

    return (
        <div className="min-h-screen bg-[#FDFBF7] text-[#333333] font-serif flex selection:bg-amber-100">
            {/* 左侧边栏 */}
            <div className="w-64 bg-white border-r border-[#EAE5D9] flex flex-col shadow-sm">
                <div className="p-6 border-b border-[#EAE5D9]">
                    <h1 className="text-xl font-bold tracking-[0.2em] text-[#4A4743]">AI STORY</h1>
                </div>
                <nav className="flex-1 p-4 space-y-2">
                    <button
                        onClick={() => setCurrentView('home')}
                        className={`w-full text-left px-4 py-3 rounded tracking-widest transition-colors ${currentView === 'home' || currentView === 'new_story' ? 'bg-[#F2F0E9] text-[#8D7B68] font-bold' : 'text-[#8D7B68] hover:bg-[#FAFAF8]'}`}
                    >
                        HOME
                    </button>
                    <button
                        onClick={() => setCurrentView('intro')}
                        className={`w-full text-left px-4 py-3 rounded tracking-widest transition-colors ${currentView === 'intro' ? 'bg-[#F2F0E9] text-[#8D7B68] font-bold' : 'text-[#8D7B68] hover:bg-[#FAFAF8]'}`}
                    >
                        PROJECT INTRO
                    </button>

                    {openTabs.length > 0 && (
                        <div className="pt-6 pb-2 border-t border-[#EAE5D9] mt-4">
                            <h3 className="text-xs font-bold tracking-widest text-gray-400 mb-3 px-4 uppercase">Open Realms</h3>
                            {openTabs.map(tab => (
                                <div
                                    key={tab.id}
                                    onClick={() => {
                                        if (activeSessionId !== tab.id || currentView !== 'chat') {
                                            loadSessionChat(tab.id);
                                        }
                                    }}
                                    className={`w-full text-left px-4 py-3 rounded tracking-widest transition-colors cursor-pointer flex justify-between items-center group mb-1 ${activeSessionId === tab.id && currentView === 'chat' ? 'bg-[#F2F0E9] text-[#8D7B68] font-bold' : 'text-[#8D7B68] hover:bg-[#FAFAF8]'}`}
                                >
                                    <span className="truncate flex-1 text-sm uppercase" title={tab.title}>
                                        {tab.title}
                                    </span>
                                    <button
                                        onClick={(e) => handleCloseTab(tab.id, e)}
                                        className="opacity-0 group-hover:opacity-100 text-[#8D7B68] hover:text-red-400 px-2 font-bold"
                                        title="Close Tab"
                                    >
                                        ×
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </nav>
            </div>

            {/* 主内容区 */}
            <div className="flex-1 flex flex-col h-screen overflow-hidden relative">

                {/* 视图1：项目介绍 */}
                {currentView === 'intro' && (
                    <div className="flex flex-col lg:flex-row h-full animate-in fade-in duration-500 overflow-hidden bg-white w-full">
                        {/* 左侧主要内容 */}
                        <div className="flex-1 p-8 sm:p-12 overflow-y-auto scroll-smooth custom-scrollbar" id="intro-scroll-container">
                            <div className="max-w-4xl mx-auto">
                                <h2 className="text-3xl font-bold tracking-[0.2em] text-[#4A4743] mb-10 border-b pb-4 border-[#EAE5D9] uppercase">Technical Architecture</h2>
                                
                                <div className="text-[#5C554B] leading-relaxed space-y-12 pb-24">
                                    
                                    {/* Section 1 */}
                                    <section id="intro-overview" className="scroll-mt-12">
                                        <h3 className="text-2xl font-bold text-[#4A4743] tracking-widest mb-6 border-l-4 border-[#8D7B68] pl-4">1. Project Overview</h3>
                                        <p className="mb-4 text-lg">
                                            This project is an infinite text adventure system driven by Large Language Models and Vector Databases. It provides an open-world narrative experience equipped with continuous memory and state management capabilities.
                                        </p>
                                        
                                        <h4 className="font-bold text-[#4A4743] mt-8 mb-3 uppercase tracking-widest text-sm">Tech Stack & Tools</h4>
                                        <ul className="list-disc pl-5 space-y-2">
                                            <li><strong className="text-[#4A4743]">Frontend:</strong> Next.js (App Router), React, Tailwind CSS.</li>
                                            <li><strong className="text-[#4A4743]">Backend API:</strong> Serverless Node.js API (with streaming support).</li>
                                            <li><strong className="text-[#4A4743]">AI Orchestration:</strong> LangChain.js.</li>
                                            <li><strong className="text-[#4A4743]">State & Cache Layer:</strong> Upstash Redis for managing God's eye state, chat history, and enabling 0-millisecond frontend context switching.</li>
                                            <li><strong className="text-[#4A4743]">Long-term Memory:</strong> Pinecone Vector Database for storing vectorized story plots.</li>
                                        </ul>

                                        <h4 className="font-bold text-[#4A4743] mt-8 mb-3 uppercase tracking-widest text-sm">LLM Selection</h4>
                                        <ul className="list-disc pl-5 space-y-2">
                                            <li><strong className="text-[#4A4743]">Story Writer:</strong> <code className="bg-[#F2F0E9] px-1 rounded text-[#8D7B68]">gpt-5-mini</code>. Chosen for its recency and vastly superior capability in generating long-context narratives seamlessly.</li>
                                            <li><strong className="text-[#4A4743]">State Machine Worker:</strong> <code className="bg-[#F2F0E9] px-1 rounded text-[#8D7B68]">gpt-4o-mini</code>. Tasked with background logical deduction and attribute extraction.</li>
                                            <li><strong className="text-[#4A4743]">Rationale:</strong> Both models offer exceptional cost-efficiency, natively support reliable JSON <strong>Structured Output</strong>, and boast extremely fast response times, which significantly helps in lowering TTFT (Time To First Token).</li>
                                        </ul>
                                    </section>

                                    {/* Section 2 */}
                                    <section id="intro-pipeline" className="scroll-mt-12">
                                        <h3 className="text-2xl font-bold text-[#4A4743] tracking-widest mb-6 border-l-4 border-[#8D7B68] pl-4">2. Memory & State Pipeline</h3>
                                        <p className="mb-6 text-lg">
                                            The system utilizes a dual-track parallel memory architecture to maintain plot continuity and retrieval accuracy while strictly optimizing token consumption per request.
                                        </p>

                                        <div className="space-y-6">
                                            <div className="bg-[#FAFAF8] p-6 rounded border border-[#EAE5D9]">
                                                <h4 className="font-bold text-[#4A4743] mb-3 text-lg">A. Global State Machine</h4>
                                                <ul className="list-disc pl-5 space-y-2">
                                                    <li><strong>Independent Updates:</strong> After each interaction, a background Worker processes the latest dialogue and extracts the world's variable deltas (<code className="bg-[#F2F0E9] px-1 rounded">State Diff</code>) strictly adhering to a Zod Schema.</li>
                                                    <li><strong>State Persistence:</strong> These diffs update attributes, inventory, quests, and world events (<code className="bg-[#F2F0E9] px-1 rounded">currentState</code>). This parameter table is permanently saved to Redis, serving as the core constraint for generating the next story turn.</li>
                                                </ul>
                                            </div>

                                            <div className="bg-[#FAFAF8] p-6 rounded border border-[#EAE5D9]">
                                                <h4 className="font-bold text-[#4A4743] mb-3 text-lg">B. Memory Lifecycle & Retrieval Flow</h4>
                                                <ul className="list-disc pl-5 space-y-2">
                                                    <li><strong>Sliding Window Archive:</strong> The latest turns that slide out of the chat history window are temporarily buffered in the <code className="bg-[#F2F0E9] px-1 rounded">Unprocessed Archive</code>. These recent plot details are fed directly into the LLM context to prevent immediate amnesia.</li>
                                                    <li><strong>Semantic Chunking & Vectorization:</strong> When the buffer reaches a threshold, the backend splits the text into pieces using semantic chunking rules, intentionally preserving context overlap between chunks to prevent semantic fragmentation. These dense narrative summaries are embedded and pushed to Pinecone.</li>
                                                    <li><strong>Intent Short-Circuit:</strong> Before querying the DB, the system evaluates the player's intent. If current UI state and recent history are completely sufficient to resolve simple actions (e.g., "I draw my sword"), it triggers a short-circuit bypass, skipping vector search entirely to eliminate latency.</li>
                                                </ul>
                                            </div>
                                        </div>
                                    </section>

                                    {/* Section 3 */}
                                    <section id="intro-future" className="scroll-mt-12">
                                        <h3 className="text-2xl font-bold text-[#4A4743] tracking-widest mb-6 border-l-4 border-[#8D7B68] pl-4">3. Future Improvements</h3>
                                        <p className="mb-6 text-lg">
                                            To address current architectural limitations during massive context scaling, future iterations will explore these paradigm shifts:
                                        </p>

                                        <div className="space-y-6">
                                            <div className="bg-[#FDFBF7] p-6 rounded border border-[#D8D3C4]">
                                                <h4 className="font-bold text-[#4A4743] mb-3 text-lg">Hybrid Search + RRF</h4>
                                                <p className="mb-2"><strong>Current Issue:</strong> Pure vector search (Dense Retrieval) excels at semantic understanding but often fails to accurately recall specific proper nouns, rare inventory items, or complex NPC names.</p>
                                                <p><strong>Improvement:</strong> Integrate BM25 sparse retrieval (exact keyword matching frequencies) alongside vector retrieval, and apply Reciprocal Rank Fusion (RRF) to cross-rank and merge the results for a dual-peak hit rate.</p>
                                            </div>

                                            <div className="bg-[#FDFBF7] p-6 rounded border border-[#D8D3C4]">
                                                <h4 className="font-bold text-[#4A4743] mb-3 text-lg">Agentic RAG (LangGraph)</h4>
                                                <p className="mb-2"><strong>Current Issue:</strong> Extremely short player commands natively sent to the vector DB often retrieve entirely irrelevant noise, which in turn severely distracts the main writer model.</p>
                                                <p className="mb-2"><strong>Improvement:</strong> Upgrade to an Agentic RAG architecture featuring cyclic reasoning loops:</p>
                                                <ul className="list-disc pl-5 mb-2">
                                                    <li><strong>Query Rewriting:</strong> An LLM will first expand the player's short intent into a fully fleshed-out contextual search query.</li>
                                                    <li><strong>Document Grading:</strong> After finding raw chunks, a fast grading model evaluates and actively filters out irrelevant noise before anything is passed to the writer.</li>
                                                </ul>
                                                <p className="text-red-400 text-sm mt-4 p-3 bg-red-50 rounded border border-red-100 italic">
                                                    <strong>⚠️ Crucial Trade-off:</strong> While logical coherence and long-term memory accuracy will skyrocket, the multiple internal LLM self-reflection loops will inevitably increase TTFT (Time To First Token), negatively impacting real-time gameplay fluidity.
                                                </p>
                                            </div>

                                            <div className="bg-[#FDFBF7] p-6 rounded border border-[#D8D3C4]">
                                                <h4 className="font-bold text-[#4A4743] mb-3 text-lg">State Hydration on Demand</h4>
                                                <p className="mb-2"><strong>Current Issue:</strong> As play continues across tens of thousands of turns, the global state tabular data will inflate indefinitely, eventually bloating prompts and exceeding efficiency thresholds.</p>
                                                <p><strong>Improvement:</strong> Shift from a naive "full state loading" approach to targeted spatial state decoupling. The system will dynamically hydrate only the sub-states strictly related to the player's current scene or ongoing active event.</p>
                                            </div>
                                        </div>
                                    </section>
                                    
                                </div>
                            </div>
                        </div>

                        {/* 右侧边栏导航 (Progress Nodes) */}
                        <div className="w-64 xl:w-72 border-l border-[#EAE5D9] p-8 hidden lg:block bg-[#FAFAF8] shrink-0">
                            <div className="sticky top-12">
                                <h4 className="text-xs font-bold tracking-[0.2em] text-[#8D7B68] mb-8 uppercase">Progress Navigation</h4>
                                {/* 节点连线进度条体验 */}
                                <ul className="space-y-8 relative before:absolute before:inset-0 before:ml-1.5 before:-translate-x-px before:h-full before:w-0.5 before:bg-[#EAE5D9]">
                                    <li className="relative flex items-center gap-4 group">
                                        <div className="h-3 w-3 rounded-full bg-white border-2 border-[#8D7B68] z-10 shrink-0 group-hover:bg-[#8D7B68] transition-colors"></div>
                                        <button onClick={() => document.getElementById('intro-overview')?.scrollIntoView({ behavior: 'smooth' })} className="text-[#8D7B68] hover:text-[#4A4743] hover:font-bold transition-all text-left text-sm tracking-widest uppercase">
                                            1. Overview
                                        </button>
                                    </li>
                                    <li className="relative flex items-center gap-4 group">
                                        <div className="h-3 w-3 rounded-full bg-white border-2 border-[#8D7B68] z-10 shrink-0 group-hover:bg-[#8D7B68] transition-colors"></div>
                                        <button onClick={() => document.getElementById('intro-pipeline')?.scrollIntoView({ behavior: 'smooth' })} className="text-[#8D7B68] hover:text-[#4A4743] hover:font-bold transition-all text-left text-sm tracking-widest uppercase">
                                            2. Pipeline
                                        </button>
                                    </li>
                                    <li className="relative flex items-center gap-4 group">
                                        <div className="h-3 w-3 rounded-full bg-white border-2 border-[#8D7B68] z-10 shrink-0 group-hover:bg-[#8D7B68] transition-colors"></div>
                                        <button onClick={() => document.getElementById('intro-future')?.scrollIntoView({ behavior: 'smooth' })} className="text-[#8D7B68] hover:text-[#4A4743] hover:font-bold transition-all text-left text-sm tracking-widest uppercase">
                                            3. Improvements
                                        </button>
                                    </li>
                                </ul>
                            </div>
                        </div>
                    </div>
                )}

                {/* 视图2：主页词卡 */}
                {currentView === 'home' && (
                    <div className="p-12 h-full overflow-y-auto w-full animate-in fade-in duration-500">
                        <h2 className="text-2xl font-bold tracking-widest text-[#4A4743] mb-10 border-b pb-4 border-[#EAE5D9]">YOUR UNIVERSES</h2>
                        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-8">
                            {isClient && savedSessions.map((session, index) => (
                                <div
                                    key={session.id}
                                    onClick={() => loadSessionChat(session.id)}
                                    className="bg-white border border-[#EAE5D9] rounded-xl p-8 hover:shadow-xl hover:border-[#8D7B68] transition-all cursor-pointer group relative h-64 flex flex-col justify-between"
                                >
                                    <div>
                                        <h3 className="text-xl font-bold text-[#4A4743] tracking-widest mb-3 line-clamp-3 break-words leading-snug" title={session.title}>{session.title}</h3>
                                        {session.style && session.style !== "UNKNOWN" && (
                                            <p className="text-xs text-[#5C554B] font-bold bg-[#F2F0E9] border border-[#EAE5D9] inline-block px-3 py-1 rounded tracking-widest uppercase">{session.style}</p>
                                        )}
                                    </div>
                                    <div className="flex justify-between items-end">
                                        <span className="text-[#8D7B68] text-sm group-hover:underline decoration-dotted tracking-widest">ENTER REALM →</span>
                                        <button
                                            onClick={(e) => handleDeleteSession(session.id, e)}
                                            className="text-red-300 hover:text-red-500 text-sm tracking-widest opacity-0 group-hover:opacity-100 transition-opacity"
                                        >
                                            DESTROY
                                        </button>
                                    </div>
                                </div>
                            ))}

                            {isClient && savedSessions.length === 0 && (
                                <div
                                    onClick={handleStartDefaultStory}
                                    className="bg-[#4A4743] border border-[#2C2B29] rounded-xl p-8 hover:shadow-xl hover:-translate-y-1 transition-all cursor-pointer group relative h-64 flex flex-col justify-between"
                                >
                                    <div>
                                        <h3 className="text-xl font-bold text-[#FDFBF7] tracking-widest mb-2">Default Scenario: Apocalypse Rebirth</h3>
                                        <p className="text-sm text-[#D8D3C4] italic mt-2 leading-relaxed">
                                            You once struggled in the abyss apocalypse for ten years, betrayed by your comrades. Now you suddenly open your eyes and find yourself reborn 30 days before the disaster...
                                        </p>
                                    </div>
                                    <div className="flex justify-between items-end">
                                        <span className="text-[#FAFAF8] text-sm group-hover:underline decoration-dotted tracking-widest font-bold">ENTER SCENARIO →</span>
                                    </div>
                                </div>
                            )}

                            {isClient && savedSessions.length < 3 && (
                                <div
                                    onClick={() => setCurrentView('new_story')}
                                    className="border-2 border-dashed border-[#D8D3C4] rounded-xl p-8 hover:bg-[#FAFAF8] hover:border-[#8D7B68] transition-all cursor-pointer flex flex-col items-center justify-center h-64 text-[#8D7B68]"
                                >
                                    <span className="text-5xl mb-4 font-light">+</span>
                                    <span className="tracking-[0.2em] font-bold">NEW UNIVERSE</span>
                                </div>
                            )}
                        </div>
                        {savedSessions.length >= 3 && (
                            <p className="mt-8 text-[#8D7B68] italic tracking-widest">You have reached the limit of 3 dimensions.</p>
                        )}
                        {loading && currentView === 'home' && (
                            <div className="mt-8 flex items-center justify-center text-[#8D7B68] tracking-widest italic animate-pulse">
                                Reconstructing the timeline, please wait...
                            </div>
                        )}
                    </div>
                )}

                {/* 视图3：新建故事 */}
                {currentView === 'new_story' && (
                    <div className="p-12 w-full max-w-4xl mx-auto h-full overflow-y-auto animate-in fade-in zoom-in duration-500">
                        <button
                            onClick={() => setCurrentView('home')}
                            className="text-[#8D7B68] mb-8 hover:underline decoration-dotted tracking-widest inline-flex items-center gap-2"
                        >
                            ← BACK TO HUB
                        </button>
                        <div className="bg-white border border-[#EAE5D9] shadow-inner rounded p-8 sm:p-12 space-y-8 bg-[url('https://www.transparenttextures.com/patterns/cream-paper.png')]">
                            <div className="text-center space-y-4">
                                <h1 className="text-3xl sm:text-4xl font-bold tracking-[0.4em] text-[#4A4743]">LEGEND BEGINS</h1>
                                <div className="h-1 w-24 bg-[#8D7B68] mx-auto"></div>
                                <p className="text-[#8D7B68] italic">Weave the initial threads of your universe...</p>
                            </div>

                            <form onSubmit={handleStartStory} className="space-y-6">
                                <div className="space-y-2">
                                    <label className="block text-sm font-medium text-[#5C554B] tracking-widest uppercase">Story Setting / World Background</label>
                                    <textarea
                                        className="w-full h-48 bg-white bg-opacity-80 border-2 border-[#D8D3C4] focus:border-[#8D7B68] outline-none p-4 text-lg leading-relaxed placeholder-gray-400 transition-all rounded"
                                        placeholder="Enter your story's background... blank means apocalypse survival."
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
                )}

                {/* 视图4：聊天界面 */}
                {currentView === 'chat' && (
                    <div className="flex-1 flex flex-col h-full bg-white relative animate-in fade-in duration-500">
                        <div className="py-5 px-6 border-b border-[#EAE5D9] bg-[#FAFAF8] flex justify-between items-center relative z-10">
                            <button
                                onClick={() => { setCurrentView('home'); setActiveSessionId(null); }}
                                className="text-xs sm:text-sm text-gray-400 hover:text-[#8D7B68] transition tracking-widest"
                            >
                                ← LEAVE REALM
                            </button>
                            <h1 className="text-xl sm:text-lg font-bold tracking-[0.3em] text-[#4A4743] truncate px-4 uppercase">
                                [ {savedSessions.find(s => s.id === activeSessionId)?.title || activeSessionId} ]
                            </h1>
                            <a
                                href={`/debug?sessionId=${activeSessionId}`}
                                target="_blank"
                                className="text-xs sm:text-sm text-gray-400 hover:text-[#8D7B68] transition underline decoration-dotted tracking-widest font-bold"
                            >
                                STORY DETAIL
                            </a>
                        </div>

                        <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 sm:p-12 space-y-10 scroll-smooth custom-scrollbar bg-[url('https://www.transparenttextures.com/patterns/cream-paper.png')]">
                            {messages.map((m, i) => (
                                <div key={i} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                                    <div
                                        className={`max-w-[90%] sm:max-w-[80%] leading-loose tracking-wide sm:text-lg text-[#2C2B29] bg-white bg-opacity-90 p-6 sm:p-8 rounded shadow-sm border border-[#EAE5D9] transition-all ${m.role === 'user' ? 'font-semibold text-[#5C554B]' : ''}`}
                                        style={m.role === 'assistant' ? { textIndent: '2em' } : {}}
                                    >
                                        {m.role === 'assistant' && m.content === '' && loading && i === messages.length - 1 ? (
                                            <span className="text-[#8D7B68] italic tracking-widest text-sm sm:text-base animate-pulse block" style={{ textIndent: 0 }}>
                                                The world is unfolding...
                                            </span>
                                        ) : (
                                            m.content.split('\n').filter(line => line.trim() !== '').map((line, idx) => (
                                                <p key={idx} className="mb-3 last:mb-0 min-h-[1.5rem]">{line}</p>
                                            ))
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>

                        <div className="p-4 sm:p-6 bg-[#FAFAF8] border-t border-[#EAE5D9] z-10 relative shadow-[0_-10px_30px_rgba(0,0,0,0.03)]">
                            <form onSubmit={handleSubmit} className="flex gap-4 max-w-5xl mx-auto items-center">
                                <input
                                    type="text"
                                    className="flex-1 bg-white border-b-2 border-[#EAE5D9] focus:border-[#8D7B68] outline-none px-4 py-3 text-lg sm:text-xl placeholder-gray-300 transition-colors"
                                    placeholder={loading ? "Calculating, please wait..." : "Where will you go?"}
                                    value={input}
                                    onChange={e => setInput(e.target.value)}
                                    disabled={loading}
                                />
                                <button
                                    type="submit"
                                    disabled={loading || !input.trim()}
                                    className="px-8 py-3 bg-[#4A4743] hover:bg-[#2C2B29] text-white font-bold tracking-[0.2em] rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed uppercase"
                                >
                                    ACTION
                                </button>
                            </form>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
