'use client';

import { useState, useEffect, useRef, Suspense } from 'react';
import { DEFAULT_STORY_SETTING } from '../lib/constants';
import UnfoldingMessage from '../components/UnfoldingMessage';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

export interface SessionMeta {
    id: string;
    title: string;
    style: string;
}

/**
 * 从失败的响应中提取可读的错误信息（兼容 JSON、纯文本以及 Vercel 超时返回的 HTML 页面）
 */
async function readErrorMessage(res: Response): Promise<string> {
    const fallback = `Request failed (HTTP ${res.status}).`;
    const text = await res.text().catch(() => '');
    try {
        const json = JSON.parse(text);
        if (typeof json?.error === 'string' && json.error) return json.error;
    } catch { }
    if (text && text.length < 500 && !text.trimStart().startsWith('<')) return text;
    if (res.status === 504) return 'The server took too long to respond. Please try again.';
    return fallback;
}

export default function Home() {
    return (
        <Suspense fallback={<div className="h-[100dvh] bg-[#FDFBF7] flex items-center justify-center text-[#8D7B68] tracking-widest italic animate-pulse">Entering the realms...</div>}>
            <HomeInner />
        </Suspense>
    );
}

function HomeInner() {
    const searchParams = useSearchParams();
    const sessionParam = searchParams.get('session');
    const fromParam = searchParams.get('from');

    // 状态管理
    const [savedSessions, setSavedSessions] = useState<SessionMeta[]>([]);
    const [openTabs, setOpenTabs] = useState<SessionMeta[]>([]);
    const [isClient, setIsClient] = useState(false);
    const [isFromPortfolio, setIsFromPortfolio] = useState(false);
    const [activeSection, setActiveSection] = useState('intro-overview');

    const [currentView, setCurrentView] = useState<'home' | 'intro' | 'chat' | 'new_story'>(() => {
        if (typeof window === 'undefined') return 'home';
        if (sessionParam) {
            const snapshot = sessionStorage.getItem(`chat_snapshot_${sessionParam}`);
            if (snapshot) return 'chat'; // 有快照，直接从 chat 开始
        }
        return 'home';
    });

    const [activeSessionId, setActiveSessionId] = useState<string | null>(() => {
        if (typeof window === 'undefined') return null;
        return sessionParam;
    });

    // Chat 状态与前端缓存
    const [messages, setMessages] = useState<{ role: 'assistant' | 'user', content: string }[]>(() => {
        if (typeof window === 'undefined') return [];
        if (!sessionParam) return [];
        try {
            const snapshot = sessionStorage.getItem(`chat_snapshot_${sessionParam}`);
            if (snapshot) return JSON.parse(snapshot);
        } catch (e) { }
        return [];
    });
    const [chatCache, setChatCache] = useState<Record<string, { role: 'assistant' | 'user', content: string }[]>>({});
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [storySetting, setStorySetting] = useState('');
    const scrollRef = useRef<HTMLDivElement>(null);
    const longPressTimers = useRef<{ [key: string]: ReturnType<typeof setTimeout> }>({});

    const handlePointerDown = (id: string, e: React.PointerEvent) => {
        longPressTimers.current[id] = setTimeout(() => {
            handleDeleteSession(id);
        }, 800);
    };

    const clearPointerTimer = (id: string) => {
        if (longPressTimers.current[id]) {
            clearTimeout(longPressTimers.current[id]);
            delete longPressTimers.current[id];
        }
    };

    const updateSessionMeta = (newMeta: SessionMeta) => {
        setSavedSessions(prev => {
            const exists = prev.find(s => s.id === newMeta.id);
            let next: SessionMeta[];
            if (exists) {
                next = prev.map(s => s.id === newMeta.id ? { ...s, ...newMeta } : s);
            } else {
                next = [newMeta, ...prev].slice(0, 3);
            }
            localStorage.setItem('story_sessions', JSON.stringify(next));
            return next;
        });
        addOpenTab(newMeta);
    };

    // 初始加载历史
    useEffect(() => {
        setIsClient(true);
        if (fromParam === 'portfolio') setIsFromPortfolio(true);

        const initialSessionId = sessionParam;
        if (initialSessionId) {
            const snapshot = sessionStorage.getItem(`chat_snapshot_${initialSessionId}`);
            if (snapshot) {
                // 已经通过 useState 懒初始化处理好了，只需要后台同步 Redis
                const meta = { id: initialSessionId, title: initialSessionId.slice(-6), style: "UNKNOWN" };
                addOpenTab(meta); // 先加上占位符
                fetch(`/api/story/load?sessionId=${initialSessionId}`)
                    .then(r => r.ok ? r.json() : null)
                    .then(data => {
                        if (data?.transcript && !data.error) {
                            const fresh = data.transcript.map((t: any) => ({ role: t.role, content: t.text }));
                            setMessages(fresh);
                            setChatCache(prev => ({ ...prev, [initialSessionId]: fresh }));
                            sessionStorage.removeItem(`chat_snapshot_${initialSessionId}`);

                            if (data.metadata) {
                                updateSessionMeta({
                                    id: initialSessionId,
                                    title: data.metadata.title || initialSessionId.slice(-6),
                                    style: data.metadata.style || "UNKNOWN"
                                });
                            }
                        }
                    })
                    .catch(() => { });
            } else {
                // 没有快照，走原来的 loadSessionChat 流程
                setTimeout(() => loadSessionChat(initialSessionId), 50);
            }
        }

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
    }, [sessionParam, fromParam]);

    // 同步 URL 状态
    useEffect(() => {
        if (!isClient) return;
        if (currentView === 'chat' && activeSessionId) {
            if (fromParam) {
                window.history.replaceState(null, '', `/?from=${fromParam}&session=${activeSessionId}`);
            } else {
                window.history.replaceState(null, '', `/?session=${activeSessionId}`);
            }
        } else if (currentView === 'home') {
            if (fromParam) {
                window.history.replaceState(null, '', `/?from=${fromParam}`);
            } else {
                window.history.replaceState(null, '', `/`);
            }
        }
    }, [activeSessionId, currentView, isClient, fromParam]);



    const addOpenTab = (meta: SessionMeta) => {
        setOpenTabs(prev => {
            const exists = prev.find(t => t.id === meta.id);
            let next;
            if (exists) {
                next = prev.map(t => t.id === meta.id ? meta : t);
            } else {
                next = [...prev, meta];
            }
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

        // 2. 从 sessionStorage 快照读（0ms，从 detail 页返回时）
        const snapshot = sessionStorage.getItem(`chat_snapshot_${sessionId}`);
        if (!forceRefresh && snapshot) {
            try {
                const cached = JSON.parse(snapshot);
                if (Array.isArray(cached) && cached.length > 0) {
                    setActiveSessionId(sessionId);
                    setMessages(cached);
                    const meta = savedSessions.find(s => s.id === sessionId) || { id: sessionId, title: sessionId.slice(-6), style: "UNKNOWN" };
                    addOpenTab(meta);
                    setCurrentView('chat'); // 立刻显示，无闪烁
                    // 然后异步从 Redis 拉最新数据，静默更新
                    fetch(`/api/story/load?sessionId=${sessionId}`)
                        .then(r => r.ok ? r.json() : null)
                        .then(data => {
                            if (data?.transcript && !data.error) {
                                const fresh = data.transcript.map((t: any) => ({ role: t.role, content: t.text }));
                                setMessages(fresh);
                                setChatCache(prev => ({ ...prev, [sessionId]: fresh }));
                                sessionStorage.removeItem(`chat_snapshot_${sessionId}`); // 用完即清
                                if (data.metadata) {
                                    updateSessionMeta({
                                        id: sessionId,
                                        title: data.metadata.title || sessionId.slice(-6),
                                        style: data.metadata.style || "UNKNOWN"
                                    });
                                }
                            }
                        })
                        .catch(() => { }); // 静默失败，保持快照内容
                    return;
                }
            } catch (e) { /* 快照损坏，继续走正常流程 */ }
        }

        setLoading(true);
        try {
            const debugRes = await fetch(`/api/story/load?sessionId=${sessionId}`);
            if (debugRes.ok) {
                const data = await debugRes.json();
                if (data.transcript && !data.error) {
                    setActiveSessionId(sessionId);
                    setMessages(data.transcript.map((t: any) => ({
                        role: t.role,
                        content: t.text
                    })));
                    const existingMeta = savedSessions.find(s => s.id === sessionId);
                    const meta: SessionMeta = {
                        id: sessionId,
                        title: data.metadata?.title || existingMeta?.title || sessionId.slice(-6),
                        style: data.metadata?.style || existingMeta?.style || "UNKNOWN"
                    };
                    updateSessionMeta(meta);
                    setCurrentView('chat');
                } else {
                    alert("Save file is corrupted or expired.");
                }
            } else if (debugRes.status === 404) {
                alert("This save file does not exist in the cloud database. Please click [DELETE] to clear this legacy dimension!");
            } else {
                alert(`Failed to fetch cloud save (HTTP ${debugRes.status}). Please check environment variables or Redis config.`);
            }
        } catch (e) {
            alert("Network error: failed to read the save file.");
        } finally {
            setLoading(false);
        }
    };

    // 开新局；setting 为空时后端会使用默认的末日设定
    const startStory = async (setting?: string): Promise<boolean> => {
        if (loading) return false;
        setLoading(true);
        try {
            const res = await fetch('/api/story/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ storySetting: setting })
            });
            if (!res.ok) throw new Error(await readErrorMessage(res));
            const data = await res.json();

            const meta: SessionMeta = {
                id: data.sessionId,
                title: data.metadata?.title || data.sessionId.slice(-6),
                style: data.metadata?.style || "UNKNOWN"
            };
            updateSessionMeta(meta);
            setActiveSessionId(meta.id);
            setMessages([{ role: 'assistant', content: data.firstPrompt }]);
            setCurrentView('chat');
            return true;
        } catch (err: any) {
            alert("Fate failed to weave the thread: " + err.message);
            return false;
        } finally {
            setLoading(false);
        }
    };

    const handleStartDefaultStory = async (e: React.MouseEvent) => {
        e.preventDefault();
        await startStory();
    };

    const handleStartStory = async (e: React.FormEvent) => {
        e.preventDefault();
        if (await startStory(storySetting.trim() || undefined)) {
            setStorySetting('');
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!input.trim() || !activeSessionId || loading) return;

        const userMessage = input.trim();
        setInput('');
        setMessages(prev => [...prev, { role: 'user', content: userMessage }, { role: 'assistant', content: '' }]);
        setLoading(true);

        // 本回合没有被服务器保存：撤回这一对消息，并把玩家的指令放回输入框方便重试
        const rollbackTurn = (reason: string) => {
            setMessages(prev => prev.slice(0, -2));
            setInput(userMessage);
            alert(reason);
        };

        try {
            const res = await fetch('/api/story/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId: activeSessionId, userInput: userMessage }),
            });

            if (!res.ok || !res.body) {
                rollbackTurn(await readErrorMessage(res));
                return;
            }

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
        } catch {
            rollbackTurn("Network connection interrupted. This turn was not saved, please try again.");
        } finally {
            setLoading(false);
        }
    };

    const handleDeleteSession = async (idToDelete: string, e?: React.MouseEvent | React.PointerEvent) => {
        if (e) e.stopPropagation();
        if (confirm("Are you sure you want to delete this world?")) {
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

            try {
                const res = await fetch('/api/story/delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId: idToDelete })
                });
                if (!res.ok) console.error("Cloud deletion failed");
            } catch (err) {
                console.error("Cloud deletion network error", err);
            }
        }
    };

    return (
        <div className="h-[100dvh] bg-[#FDFBF7] text-[#333333] font-serif flex flex-col-reverse md:flex-row selection:bg-amber-100 overflow-hidden">
            {/* 移动端底部导航 / 左侧边栏 */}
            <div className="w-full md:w-64 bg-white border-t md:border-r md:border-t-0 border-[#EAE5D9] flex flex-col shadow-[0_-2px_10px_rgba(0,0,0,0.02)] md:shadow-sm shrink-0 md:h-[100dvh] z-20 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:pb-0">
                <div className="hidden md:flex p-4 md:p-6 border-b border-[#EAE5D9] justify-between items-center">
                    <h1 className="text-xl font-bold tracking-[0.2em] text-[#4A4743]">AI STORY</h1>
                </div>
                <nav className="flex-none md:flex-1 p-2 md:p-4 flex flex-row md:flex-col gap-2 md:gap-0 md:space-y-2 overflow-x-auto whitespace-nowrap [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
                    <button
                        onClick={() => setCurrentView('intro')}
                        className={`text-xs md:text-base shrink-0 md:w-full text-center md:text-left px-3 sm:px-4 py-2 md:py-3 rounded tracking-wider md:tracking-widest transition-all duration-300 flex items-center justify-center md:justify-start gap-2 relative overflow-hidden group ${currentView === 'intro'
                                ? 'bg-[#F2F0E9] text-[#8D7B68] font-bold'
                                : 'text-[#8D7B68] hover:bg-[#FAFAF8]'
                            }`}
                    >
                        <span>INTRO</span>
                        <span className="text-[8px] tracking-normal px-1.5 py-0.5 rounded leading-none bg-[#8D7B68]/15 text-[#8D7B68] font-sans font-bold uppercase ml-auto hidden md:inline-block">
                            Tech Doc
                        </span>
                    </button>
                    <button
                        onClick={() => setCurrentView('home')}
                        className={`text-xs md:text-base shrink-0 md:w-full text-center md:text-left px-3 sm:px-4 py-2 md:py-3 rounded tracking-wider md:tracking-widest transition-colors ${currentView === 'home' || currentView === 'new_story' ? 'bg-[#F2F0E9] text-[#8D7B68] font-bold' : 'text-[#8D7B68] hover:bg-[#FAFAF8]'}`}
                    >
                        HOME
                    </button>

                    {isFromPortfolio && (
                        <a
                            href="https://raygan.vercel.app/"
                            className="text-[10px] md:text-xs shrink-0 md:w-full text-center px-4 py-2 md:py-3 rounded tracking-widest md:tracking-[0.2em] transition-all bg-[#8D7B68] text-white font-bold hover:bg-[#736353] shadow-sm hover:shadow-md hover:-translate-y-px flex items-center justify-center gap-1.5 md:my-2 border border-[#736353]"
                        >
                            <span className="opacity-70">←</span> BACK TO PORTFOLIO
                        </a>
                    )}

                    {openTabs.length > 0 && (
                        <div className="flex flex-row md:flex-col items-center md:items-stretch md:pt-6 md:pb-2 md:border-t border-[#EAE5D9] md:mt-4 gap-2 md:gap-0 pl-2 md:pl-0 border-l md:border-l-0">
                            <h3 className="shrink-0 flex items-center md:hidden text-[10px] font-bold tracking-widest text-gray-400 px-1 uppercase">REALMS:</h3>
                            <h3 className="hidden md:block text-xs font-bold tracking-widest text-gray-400 mb-3 px-4 uppercase">Open Realms</h3>
                            {openTabs.map(tab => (
                                <div
                                    key={tab.id}
                                    onClick={() => {
                                        if (activeSessionId !== tab.id || currentView !== 'chat') {
                                            loadSessionChat(tab.id);
                                        }
                                    }}
                                    className={`shrink-0 md:w-full text-center md:text-left px-3 sm:px-4 py-2 md:py-3 rounded tracking-wider md:tracking-widest transition-colors cursor-pointer flex justify-between items-center group md:mb-1 ${activeSessionId === tab.id && currentView === 'chat' ? 'bg-[#F2F0E9] text-[#8D7B68] font-bold' : 'text-[#8D7B68] hover:bg-[#FAFAF8]'}`}
                                >
                                    <span className="truncate flex-1 text-xs md:text-sm uppercase md:w-auto w-16 md:w-24" title={tab.title}>
                                        {tab.title}
                                    </span>
                                    <button
                                        onClick={(e) => handleCloseTab(tab.id, e)}
                                        className="md:opacity-0 group-hover:opacity-100 text-[#8D7B68] hover:text-red-400 px-1 md:px-2 font-bold ml-1 md:ml-0 text-xs md:text-base"
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
            <div className="flex-1 flex flex-col overflow-hidden relative">

                {/* 视图1：项目介绍 */}
                {currentView === 'intro' && (
                    <div className="flex flex-col lg:flex-row h-full animate-in fade-in duration-500 overflow-hidden bg-white w-full">                        {/* 左侧主要内容 */}
                        <div
                            className="flex-1 p-8 sm:p-12 overflow-y-auto scroll-smooth custom-scrollbar"
                            id="intro-scroll-container"
                            onScroll={(e) => {
                                const target = e.currentTarget;
                                // Buffer of 20px to detect bottom
                                if (target.scrollHeight - target.scrollTop <= target.clientHeight + 20) {
                                    setActiveSection('intro-learned');
                                    return;
                                }

                                const sections = ['intro-overview', 'intro-pipeline', 'intro-engineering', 'intro-limitations', 'intro-learned'];
                                const containerRect = target.getBoundingClientRect();
                                const focusY = containerRect.top + 150;

                                for (let i = sections.length - 1; i >= 0; i--) {
                                    const el = document.getElementById(sections[i]);
                                    if (el) {
                                        if (el.getBoundingClientRect().top <= focusY) {
                                            setActiveSection(sections[i]);
                                            break;
                                        }
                                    }
                                }
                            }}
                        >
                            <div className="max-w-4xl mx-auto">
                                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-10 border-b pb-4 border-[#EAE5D9]">
                                    <h2 className="text-3xl font-bold tracking-[0.2em] text-[#4A4743] uppercase mb-4 sm:mb-0">Technical Architecture</h2>
                                    <a href="https://github.com/Ray-gyr/storyAI" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#FAFAF8] border border-[#D8D3C4] text-[#8D7B68] hover:text-[#4A4743] hover:bg-[#F2F0E9] hover:border-[#8D7B68] transition-all text-sm font-bold tracking-widest shadow-sm hover:shadow group w-fit">
                                        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" className="group-hover:scale-110 transition-transform">
                                            <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
                                        </svg>
                                        GITHUB
                                    </a>
                                </div>

                                <div className="text-[#5C554B] leading-relaxed space-y-12 pb-24">

                                    {/* Section 1 */}
                                    <section id="intro-overview" className="scroll-mt-12">
                                        <h3 className="text-2xl font-bold text-[#4A4743] tracking-widest mb-6 border-l-4 border-[#8D7B68] pl-4">1. Project Overview</h3>
                                        <p className="mb-4 text-lg">
                                            LLM-powered story games break down at scale. After ~20 turns, models forget earlier plot points. After ~100 turns, context windows overflow. Over hundreds of turns, the world loses coherence entirely.
                                        </p>
                                        <p className="mb-4 text-lg">
                                            Naive RAG pipelines solve the context overflow problem but fail at exact object recall. Standard semantic similarity is often too "fuzzy" to reliably retrieve specific entities, leading to "entity drift" where critical plot objects vanish or transform.
                                        </p>
                                        <p className="mb-6 text-lg">
                                            This project is my attempt to engineer around all three failure modes simultaneously.
                                        </p>

                                        <h4 className="font-bold text-[#4A4743] mt-8 mb-3 uppercase tracking-widest text-sm">Version History</h4>
                                        <div className="bg-[#FAFAF8] p-4 rounded border border-[#EAE5D9] space-y-3 text-sm sm:text-base">
                                            <p><strong className="text-[#4A4743]">v3 — Oct 2026 (let the writer read the details).</strong> The writer now gets the original text of all 10 retrieved chunks, in story order with turn numbers, instead of summaries only; chunk summaries were also made longer and more detailed. After play-testing, a Story Drive rule makes every turn add one new development toward the current goal, instead of ending on &ldquo;nothing happens&rdquo;. On a held-out 300-round story, correct answers to questions about the past went from 29/91 to 83/91.</p>
                                            <p><strong className="text-[#4A4743]">v2 — Oct 2026 (evaluation-driven redesign).</strong> I benchmarked my own design decisions and reversed three of them: replaced vector-only tier search with BM25 + vector hybrid retrieval, removed the intent short-circuit router, and rewrote the writer prompt for memory fidelity. Recall on the held-out story went from 82% to 95%, and it no longer decays as the story grows. Details are in Key Engineering Decisions.</p>
                                            <p><strong className="text-[#4A4743]">v1 — Mar 2026 (initial release).</strong> Dual-track memory with entity-filtered vector &ldquo;tier search&rdquo;, and an LLM router that skipped retrieval when it judged the state sufficient.</p>
                                        </div>

                                        <h4 className="font-bold text-[#4A4743] mt-8 mb-3 uppercase tracking-widest text-sm">Tech Stack</h4>
                                        <div className="bg-[#FAFAF8] p-4 rounded border border-[#EAE5D9] overflow-x-auto">
                                            <table className="w-full text-left border-collapse">
                                                <tbody>
                                                    <tr className="border-b border-[#EAE5D9]"><th className="py-2 pr-4 text-[#4A4743]">Frontend</th><td className="py-2">Next.js (App Router), React, Tailwind CSS</td></tr>
                                                    <tr className="border-b border-[#EAE5D9]"><th className="py-2 pr-4 text-[#4A4743]">Backend</th><td className="py-2">Serverless Node.js with streaming</td></tr>
                                                    <tr className="border-b border-[#EAE5D9]"><th className="py-2 pr-4 text-[#4A4743]">AI Orchestration</th><td className="py-2">LangChain.js</td></tr>
                                                    <tr className="border-b border-[#EAE5D9]"><th className="py-2 pr-4 text-[#4A4743]">State & Cache</th><td className="py-2">Upstash Redis</td></tr>
                                                    <tr className="border-b border-[#EAE5D9]"><th className="py-2 pr-4 text-[#4A4743]">Long-term Memory</th><td className="py-2">Pinecone Vector DB</td></tr>
                                                    <tr><th className="py-2 pr-4 text-[#4A4743]">Validation</th><td className="py-2">Zod schema</td></tr>
                                                </tbody>
                                            </table>
                                        </div>

                                        <h4 className="font-bold text-[#4A4743] mt-8 mb-3 uppercase tracking-widest text-sm">LLM Selection Rationale</h4>
                                        <div className="bg-[#FAFAF8] p-4 rounded border border-[#EAE5D9] overflow-x-auto">
                                            <table className="w-full text-left border-collapse text-sm sm:text-base">
                                                <thead>
                                                    <tr className="border-b-2 border-[#D8D3C4] text-[#4A4743]"><th className="py-2 pr-4 w-1/4">Role</th><th className="py-2 pr-4 w-1/4">Model</th><th className="py-2">Reason</th></tr>
                                                </thead>
                                                <tbody>
                                                    <tr className="border-b border-[#EAE5D9]">
                                                        <td className="py-3 pr-4 font-bold text-[#4A4743]">Story Writer</td>
                                                        <td className="py-3 pr-4"><code className="bg-[#F2F0E9] px-1 rounded text-[#8D7B68]">gpt-6-luna</code></td>
                                                        <td className="py-3">A newer model at about 1/3 the cost of gpt-5-mini per turn; memory fidelity held steady after the switch (75/88 vs 73/88)</td>
                                                    </tr>
                                                    <tr className="border-b border-[#EAE5D9]">
                                                        <td className="py-3 pr-4 font-bold text-[#4A4743]">World Setup</td>
                                                        <td className="py-3 pr-4"><code className="bg-[#F2F0E9] px-1 rounded text-[#8D7B68]">gpt-5-mini</code></td>
                                                        <td className="py-3">The original writer model; still used for the initial state and title, which run once per story</td>
                                                    </tr>
                                                    <tr>
                                                        <td className="py-3 pr-4 font-bold text-[#4A4743]">State Worker, Summaries, Query Rewriter</td>
                                                        <td className="py-3 pr-4"><code className="bg-[#F2F0E9] px-1 rounded text-[#8D7B68]">gpt-4o-mini</code></td>
                                                        <td className="py-3">Used since v1 and kept unchanged; cheap, with reliable structured JSON output</td>
                                                    </tr>
                                                </tbody>
                                            </table>
                                        </div>
                                    </section>

                                    {/* Section 2 */}
                                    <section id="intro-pipeline" className="scroll-mt-12">
                                        <h3 className="text-2xl font-bold text-[#4A4743] tracking-widest mb-6 border-l-4 border-[#8D7B68] pl-4">2. Dual-Track Parallel Memory</h3>
                                        <p className="mb-6 text-lg">
                                            Rather than a single memory strategy, the system runs two independent tracks in parallel after every turn:
                                        </p>

                                        <div className="space-y-6">
                                            <div className="bg-[#FAFAF8] p-6 rounded border border-[#EAE5D9]">
                                                <h4 className="font-bold text-[#4A4743] mb-3 text-lg">Track 1 — Global State Machine</h4>
                                                <p className="mb-4">After the story generator LLM (gpt-6-luna) finishes generating a response, a background Worker LLM (gpt-4o-mini) runs independently of the main story generation. It reads the latest dialogue and extracts <strong>only what changed</strong> — a structured <code>StateDiff</code> validated against a Zod schema:</p>
                                                <pre className="text-xs sm:text-sm text-gray-700 bg-white p-4 rounded border border-[#EAE5D9] overflow-x-auto mb-4 leading-relaxed">
                                                    {`// Example diff extracted after "I pick up the ancient sword"
{
  updated_characters:[{name:"player",description:"A young man from the Shire holds the ancient sword"}],
  added_items:[{name:"Ancient Sword of Angels",description:"A magical sword made by angels that glows in the dark."}],
  inventory_added: ["Ancient Sword of Angels"],
  state_summary:"The player picked up the Ancient Sword of Angels."
}`}
                                                </pre>
                                                <p className="mb-2">This diff is merged into <strong>CurrentState</strong> in Redis. The state table stays bounded regardless of play length, and every future generation gets the full world state as a constraint without any growing overhead.</p>
                                                <p className="text-sm bg-[#F2F0E9] p-3 rounded text-[#5C554B] mt-4"><strong>Why this matters:</strong> Separating state extraction from story generation means the main LLM never has to "remember" facts — they're always injected as structured ground truth.</p>
                                            </div>

                                            <div className="bg-[#FAFAF8] p-6 rounded border border-[#EAE5D9]">
                                                <h4 className="font-bold text-[#4A4743] mb-3 text-lg">Track 2 — Memory Lifecycle</h4>
                                                <p className="mb-4">Chat history is maintained as a FIFO queue in Redis.</p>
                                                <ul className="list-decimal pl-5 space-y-2 mb-4">
                                                    <li><strong>Sliding Window</strong> — recent turns are kept in memory for immediate context.</li>
                                                    <li><strong>Unprocessed Archive</strong> — turns that overflow the sliding window are stored here.</li>
                                                    <li><strong>Semantic Chunking</strong> — when the buffer hits threshold, text is split with <strong>context overlap between chunks</strong> to prevent semantic fragmentation at boundaries. An LLM writes a detailed summary of each chunk (every story-relevant fact, in the story&apos;s own words) and lists the entities involved.</li>
                                                    <li><strong>Vectorization → Pinecone</strong> — summary embeddings stored with metadata (turn range, location, characters and items involved, importance flags). Summaries and original text are also kept in Redis.</li>
                                                    <li><strong>Retrieval</strong> — every turn, the system retrieves the 10 most relevant chunks with hybrid BM25 + vector search, and gives the story generator LLM each chunk&apos;s summary and original text, in story order.</li>
                                                </ul>
                                                <p className="text-sm bg-[#F2F0E9] p-3 rounded text-[#5C554B] mt-4"><strong>Why this matters:</strong> Separating memory into sliding window and long-term memory allows the system to maintain both immediate context and long-term coherence without overflowing the context window.</p>
                                            </div>

                                            {/* System Architecture Flowchart */}
                                            <div className="my-10 p-2 sm:p-4 bg-[#FAFAF8] rounded border border-[#EAE5D9] shadow-sm flex flex-col items-center">
                                                <h4 className="font-bold text-[#4A4743] mb-4 sm:mb-6 tracking-widest text-center uppercase md:mt-2">System Architecture Diagram</h4>
                                                <img
                                                    src="/pipeline.png"
                                                    alt="System Architecture Pipeline"
                                                    className="w-full max-w-5xl max-h-[90vh] rounded shadow-[0_4px_20px_rgba(0,0,0,0.05)] border border-[#D8D3C4] bg-white object-contain"
                                                />
                                            </div>
                                        </div>
                                    </section>

                                    {/* Section 3 */}
                                    <section id="intro-engineering" className="scroll-mt-12">
                                        <h3 className="text-2xl font-bold text-[#4A4743] tracking-widest mb-6 border-l-4 border-[#8D7B68] pl-4">3. Key Engineering Decisions</h3>

                                        <div className="space-y-8">
                                            <div>
                                                <h4 className="text-xl font-bold text-[#4A4743] mb-3">Benchmark: two 300-round stories</h4>
                                                <p className="mb-4">Every decision below was tested, not assumed. Two stories were played for 300 rounds by an AI auto-player (130 memory chunks each). The <strong>dev story</strong> is for trying ideas; the <strong>test story</strong> is only used to check a version after its code is frozen. The <strong>main</strong> question set has fairly long questions with context; the <strong>hard</strong> set has short, low-context questions, the way a real player types. <strong>Recall@10</strong> asks whether a correct chunk is among the 10 given to the writer; <strong>end to end</strong> asks whether the writer&apos;s answer agrees with the story, judged by an LLM I checked by hand (about 94% accurate).</p>
                                                <div className="bg-[#FAFAF8] p-4 rounded border border-[#EAE5D9] overflow-x-auto mb-2">
                                                    <table className="w-full text-left border-collapse text-sm sm:text-base">
                                                        <thead>
                                                            <tr className="border-b-2 border-[#D8D3C4] text-[#4A4743]"><th className="py-2 pr-4">Test story</th><th className="py-2 pr-4">Recall@10, main</th><th className="py-2 pr-4">Recall@10, hard</th><th className="py-2 pr-4">Correct, main</th><th className="py-2">Correct, hard</th></tr>
                                                        </thead>
                                                        <tbody>
                                                            <tr className="border-b border-[#EAE5D9]"><td className="py-2 pr-4">v1</td><td className="py-2 pr-4">82.4%</td><td className="py-2 pr-4">70.2%</td><td className="py-2 pr-4">—</td><td className="py-2">—</td></tr>
                                                            <tr className="border-b border-[#EAE5D9]"><td className="py-2 pr-4">v2</td><td className="py-2 pr-4">94.5%</td><td className="py-2 pr-4">83.0%</td><td className="py-2 pr-4">29 / 91</td><td className="py-2">21 / 47</td></tr>
                                                            <tr><td className="py-2 pr-4 font-bold text-[#4A4743]">v3 (deployed)</td><td className="py-2 pr-4 font-bold">94.5%</td><td className="py-2 pr-4 font-bold">89.4%</td><td className="py-2 pr-4 font-bold">83 / 91</td><td className="py-2 font-bold">40 / 47</td></tr>
                                                        </tbody>
                                                    </table>
                                                </div>
                                            </div>

                                            <div>
                                                <h4 className="text-xl font-bold text-[#4A4743] mb-3">Hybrid Retrieval (BM25 + vector, quota fusion) <span className="text-sm font-normal text-[#8D7B68]">v2, Oct 2026</span></h4>
                                                <p className="mb-4">Every turn runs two retrievers over the session&apos;s memory chunks and merges them:</p>
                                                <ul className="list-disc pl-5 space-y-1 mb-4 text-sm sm:text-base">
                                                    <li><strong>Vector:</strong> the player&apos;s raw input is embedded and searched in Pinecone. It starts in parallel with the LLM query rewriter, so it adds no latency after rewriting.</li>
                                                    <li><strong>BM25:</strong> the raw input plus the rewriter&apos;s output (pronouns replaced with entity names, entities appended) is scored with Okapi BM25 over the chunk summaries, kept in Redis and scored in memory per request.</li>
                                                    <li><strong>Fusion:</strong> BM25&apos;s top 3 take the first slots, and the vector ranking fills the rest up to 10.</li>
                                                </ul>

                                                <div className="bg-[#FAFAF8] p-4 rounded border border-[#EAE5D9] mb-4">
                                                    <strong className="block text-[#4A4743] mb-2">How I got here</strong>
                                                    <p className="mb-2 text-sm sm:text-base">The first version used vector-only &ldquo;tier search&rdquo; (an entity-filtered vector query topped up with an unfiltered one), because I assumed frequent entity names would flatten BM25&apos;s IDF. I tested that on a machine-played 100-round pilot story: 44 chunks, 88 recall questions, half reusing the chunk&apos;s wording and half paraphrased.</p>
                                                    <ul className="list-disc pl-5 space-y-1 mb-2 text-sm sm:text-base">
                                                        <li>The premise held only for core characters: the protagonist appears in 95% of chunk summaries (IDF 0.06 vs 2.3 for a typical event word), largely because the summarizer replaces pronouns with names.</li>
                                                        <li>BM25 still matched or beat tier search, and removing entity terms from its query <em>hurt</em> it.</li>
                                                        <li>The entity filter barely filtered: 77% of chunks passed it on average.</li>
                                                        <li>Vector search won where wording diverged (&ldquo;jacket&rdquo; vs &ldquo;coat&rdquo;); BM25 won where it matched. They were complementary.</li>
                                                    </ul>
                                                    <p className="text-sm sm:text-base">Tuning 9 parameters on 40 questions overfit (0.78 → 0.60 MRR on held-out questions), so I used grouped cross-validation to decide <em>how much</em> to tune. The pilot picked weighted RRF. On the 300-round dev story, though, RRF with BM25 weight 4 let BM25 decide the whole candidate set, so I replaced it with the simpler quota rule (fewest parameters within 0.01 of the best).</p>
                                                </div>

                                                <div className="bg-[#FAFAF8] p-4 rounded border border-[#EAE5D9] overflow-x-auto mb-2">
                                                    <table className="w-full text-left border-collapse text-sm sm:text-base">
                                                        <thead>
                                                            <tr className="border-b-2 border-[#D8D3C4] text-[#4A4743]"><th className="py-2 pr-4">Pilot story</th><th className="py-2 pr-4">MRR@10</th><th className="py-2 pr-4">Hit@5</th><th className="py-2">Hit@5 (paraphrased)</th></tr>
                                                        </thead>
                                                        <tbody>
                                                            <tr className="border-b border-[#EAE5D9]"><td className="py-2 pr-4">Tier search (v1)</td><td className="py-2 pr-4">0.49</td><td className="py-2 pr-4">0.66</td><td className="py-2">0.61</td></tr>
                                                            <tr className="border-b border-[#EAE5D9]"><td className="py-2 pr-4">BM25 only</td><td className="py-2 pr-4">0.66</td><td className="py-2 pr-4">0.81</td><td className="py-2">0.64</td></tr>
                                                            <tr><td className="py-2 pr-4 font-bold text-[#4A4743]">Hybrid (RRF, out-of-sample)</td><td className="py-2 pr-4 font-bold">0.67</td><td className="py-2 pr-4 font-bold">0.88</td><td className="py-2 font-bold">0.77</td></tr>
                                                        </tbody>
                                                    </table>
                                                </div>
                                                <p className="text-sm text-[#8D7B68] italic">Tier search and BM25-only have no tuned parameters, so they are scored directly on all 88 questions. The hybrid numbers are out-of-sample (4-fold cross-validation grouped by source chunk, repeated 25 times); scored on the questions it was tuned on, it would read 0.70 / 0.91 / 0.84.</p>
                                                <p className="mt-4 text-sm bg-[#F2F0E9] p-3 rounded text-[#5C554B]"><strong>Result on the held-out test story:</strong> Recall@10 rose from 82.4% to 94.5% (main set) and from 70.2% to 83.0% (hard set). On early events, v1 fell from 93% to 78% as the story tripled in length, while v2 stayed at 100% → 98%.</p>
                                            </div>

                                            <div>
                                                <h4 className="text-xl font-bold text-[#4A4743] mb-3">Removed: Intent Short-Circuit <span className="text-sm font-normal text-[#8D7B68]">v2, Oct 2026</span></h4>
                                                <p className="mb-4">The first version asked an LLM router before every retrieval: <em>&ldquo;Can the current state + recent history answer this without going to the DB?&rdquo;</em> If yes, retrieval was skipped to save latency.</p>
                                                <p className="mb-4">I measured it on a machine-played 100-round story and removed it. It skipped retrieval on <strong>37 of 40</strong> recall questions, and for <strong>32</strong> of those the answer was not in the state or recent history, so the writer had to make up the past. For ordinary actions it short-circuited only 4 of 100 turns, saving ~0.6s on 4% of turns instead of the ~30% I had assumed.</p>
                                                <p className="text-sm bg-[#F2F0E9] p-3 rounded text-[#5C554B]"><strong>Lesson:</strong> the router was inverted. Questions about the past looked &ldquo;answerable&rdquo; because their entities appear in the state, while actions almost always went to retrieval. Every turn now retrieves.</p>
                                            </div>

                                            <div>
                                                <h4 className="text-xl font-bold text-[#4A4743] mb-3">Memory Fidelity in the Writer Prompt <span className="text-sm font-normal text-[#8D7B68]">v2, Oct 2026</span></h4>
                                                <p className="mb-4">Retrieval was not the only failure point. In an end-to-end check (88 recall questions; the story model answers, an LLM judge compares the answer with the recorded fact), most wrong answers happened even though the right memory <em>was</em> in the prompt. The writer prompt was working against it: &ldquo;only use elements present in the current state&rdquo; excluded everything retrieved, memories sat in an unlabeled &ldquo;Context&rdquo; line, and &ldquo;no inner thoughts&rdquo; ruled out recalling anything.</p>
                                                <p className="mb-4">The prompt now labels the memory inputs and adds a Memory Fidelity rule. The past is fixed. When the player asks about an earlier event, the writer answers from memory exactly as recorded, or says the protagonist can&apos;t recall it. For ordinary actions, memories are used silently as background.</p>
                                                <div className="bg-[#FAFAF8] p-4 rounded border border-[#EAE5D9] overflow-x-auto mb-2">
                                                    <table className="w-full text-left border-collapse text-sm sm:text-base">
                                                        <thead>
                                                            <tr className="border-b-2 border-[#D8D3C4] text-[#4A4743]"><th className="py-2 pr-4">Writer prompt</th><th className="py-2 pr-4">Consistent with the past</th><th className="py-2">Contradicts it</th></tr>
                                                        </thead>
                                                        <tbody>
                                                            <tr className="border-b border-[#EAE5D9]"><td className="py-2 pr-4">Before</td><td className="py-2 pr-4">48 / 88</td><td className="py-2">37 / 88</td></tr>
                                                            <tr><td className="py-2 pr-4 font-bold text-[#4A4743]">After</td><td className="py-2 pr-4 font-bold">78 / 88</td><td className="py-2 font-bold">10 / 88</td></tr>
                                                        </tbody>
                                                    </table>
                                                </div>
                                                <p className="text-sm text-[#8D7B68] italic">31 answers improved and 1 got worse; action turns keep their length and style. The first draft of the new prompt was also run on these questions; the follow-up edit only targeted action turns, but the set is not fully unseen.</p>
                                            </div>

                                            <div>
                                                <h4 className="text-xl font-bold text-[#4A4743] mb-3">Fixing the Benchmark Itself</h4>
                                                <p className="mb-4">Two problems were in the measurement, not the system. The first judge had no &ldquo;can&apos;t recall&rdquo; verdict, so it scored honest uncertainty as a contradiction; the new judge separates the two (majority of 3, checked by hand against a second judge model). And many wrong answers came from bad questions: &ldquo;the 42nd water crisis&rdquo;, amounts that change over time, facts that happen several times. I rebuilt the set with stricter generation, LLM screening, manual review, and a check that every question has one answer across the story.</p>
                                                <p className="text-sm bg-[#F2F0E9] p-3 rounded text-[#5C554B]"><strong>Lesson:</strong> with the same stories and the same system, the test score went from 55% to 79%. Check the test, not just the system.</p>
                                            </div>

                                            <div>
                                                <h4 className="text-xl font-bold text-[#4A4743] mb-3">Original Text for Every Retrieved Memory <span className="text-sm font-normal text-[#8D7B68]">v3, Oct 2026</span></h4>
                                                <p className="mb-4">With v2, retrieval found a correct chunk for 94.5% of test questions, but the writer answered only 29 of 91 correctly. It only saw summaries (about 55 words for 413 words of story), and only 10–19% of answers were still in the summary. v3 gives the writer the original text of all 10 retrieved chunks, in story order with turn numbers.</p>
                                                <p className="mb-4">An intermediate build attached original text to the top 3 only. It showed that when the right chunk sat at rank 4–10 (summary only), the writer answered just 2 of 16 correctly; with original text for all 10, it answered 16 of 16.</p>
                                                <p className="text-sm bg-[#F2F0E9] p-3 rounded text-[#5C554B]"><strong>Result on the test story:</strong> correct answers went from 29/91 to 82/91 (main set) and from 21/47 to 37/47 (hard set), for about 2,500 extra input tokens per turn (about $0.00025) and no change in latency.</p>
                                            </div>

                                            <div>
                                                <h4 className="text-xl font-bold text-[#4A4743] mb-3">Detailed Chunk Summaries <span className="text-sm font-normal text-[#8D7B68]">v3, Oct 2026</span></h4>
                                                <p className="mb-4">After that, almost every remaining error was a retrieval miss: search only sees summaries, so a detail the summary dropped can&apos;t be found. The summary prompt now keeps every story-relevant fact (what was said, items, prices, decisions, outcomes, clues) in the story&apos;s own words, about 125 words instead of 55. Both BM25 and the vector index use them.</p>
                                                <p className="text-sm bg-[#F2F0E9] p-3 rounded text-[#5C554B]"><strong>Result on the test story:</strong> a small extra gain. On the hard set, Recall@10 went from 83.0% to 89.4% and correct answers from 37/47 to 40/47, exactly the 3 extra chunks found; not statistically significant at n=47, but the same direction as on the dev story. On the main set, no change (82 → 83, within noise).</p>
                                            </div>
                                        </div>
                                    </section>

                                    {/* Section 4 */}
                                    <section id="intro-limitations" className="scroll-mt-12">
                                        <h3 className="text-2xl font-bold text-[#4A4743] tracking-widest mb-6 border-l-4 border-[#8D7B68] pl-4">4. Limitations & What I'd Build Next</h3>
                                        <p className="mb-6 text-lg">
                                            I documented these honestly because I think identifying architectural ceilings is as important as building the system.
                                        </p>

                                        <div className="space-y-6">
                                            <div className="bg-[#FDFBF7] p-6 rounded border border-[#D8D3C4]">
                                                <h4 className="font-bold text-[#4A4743] mb-3 text-lg">Timeline Questions</h4>
                                                <p className="mb-2"><strong>Current issue 1:</strong> Questions like &ldquo;the third time I faced a water shortage&rdquo; remain the weakest category. The retrieved set usually holds only some occurrences of a recurring event, so the writer can&apos;t tell which one is &ldquo;the third&rdquo;.</p>
                                                <p className="mb-2"><strong>Next:</strong> Ordinal-aware retrieval: the rewriter detects &ldquo;Nth time&rdquo;, retrieves many chunks matching the event, sorts them by turn, and picks the Nth episode.</p>
                                            </div>

                                            <div className="bg-[#FDFBF7] p-6 rounded border border-[#D8D3C4]">
                                                <h4 className="font-bold text-[#4A4743] mb-3 text-lg">State Hydration on Demand</h4>
                                                <p className="mb-2"><strong>Current issue 2:</strong> Current state table is a global table, which can lead to a large state table as the number of turns increases.</p>
                                                <p className="mb-2"><strong>Next:</strong> Spatial state decoupling — only hydrate sub-states relevant to the player's current scene or active event, not the full world state on every call.</p>
                                                <p className="text-[#8D7B68] text-sm mt-4 p-3 bg-red-50 rounded border border-red-100 italic">
                                                    <strong>⚠️ Risk:</strong> It's hard to distinguish whether a state is relevant to the scene. Some items may have a hidden-trigger linked to a world state in a far-off region. Moreover, to know what sub-states are relevant, the system must first understand the player intent. However, to fully comprehend the intent, the LLM often requires the context provided by those sub-states. This creates a chicken-and-egg problem.
                                                </p>
                                            </div>

                                            <div className="bg-[#FDFBF7] p-6 rounded border border-[#D8D3C4]">
                                                <h4 className="font-bold text-[#4A4743] mb-3 text-lg">Benchmark Limits</h4>
                                                <p className="mb-2"><strong>Current issue 3:</strong> The benchmark has only two stories, both played by an AI, and the test story has been reused for several versions. Each version was frozen before its test run, but the results are likely somewhat optimistic; a fresh test story would give a cleaner number.</p>
                                                <p className="mb-2"><strong>Other ideas, not yet tested:</strong></p>
                                                <ol className="list-decimal pl-5 space-y-1 text-sm sm:text-base">
                                                    <li>Document expansion at write time: the summary call also emits synonyms and likely questions for BM25.</li>
                                                    <li>Deeper candidates + re-ranking: take the top 30 from each retriever and let a small model pick the final 10.</li>
                                                    <li>MMR diversity: recurring scenes produce near-duplicate chunks that can fill the top 10.</li>
                                                </ol>
                                            </div>
                                        </div>
                                    </section>

                                    {/* Section 5 */}
                                    <section id="intro-learned" className="scroll-mt-12">
                                        <h3 className="text-2xl font-bold text-[#4A4743] tracking-widest mb-6 border-l-4 border-[#8D7B68] pl-4">5. What I Learned</h3>
                                        <p className="mb-4 text-lg">
                                            Building this forced me to think carefully about <strong className="text-[#4A4743]">token budget as a first-class engineering constraint</strong> — every architectural decision (state diffs instead of full state, sliding window instead of full history) was made to reduce tokens per request without sacrificing coherence.
                                        </p>
                                        <div className="text-lg bg-[#FAFAF8] p-5 rounded border border-[#EAE5D9] mt-6 font-medium text-[#5C554B]">
                                            The biggest insight: <strong className="text-[#4A4743]">finding the right memory and reading it are two different problems.</strong> v2 made retrieval find the right chunk 95% of the time, but correct answers stayed at 32% until v3 let the writer read the original text (91%).
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
                                    <li className="relative">
                                        <button onClick={() => document.getElementById('intro-overview')?.scrollIntoView({ behavior: 'smooth' })} className="flex items-center gap-4 group w-full text-left">
                                            <div className={`h-3 w-3 rounded-full border-2 border-[#8D7B68] z-10 shrink-0 transition-colors ${activeSection === 'intro-overview' ? 'bg-[#8D7B68]' : 'bg-white group-hover:bg-[#8D7B68]'}`}></div>
                                            <span className={`transition-all text-sm tracking-widest uppercase ${activeSection === 'intro-overview' ? 'text-[#4A4743] font-bold' : 'text-[#8D7B68] group-hover:text-[#4A4743] group-hover:font-bold'}`}>
                                                1. Overview
                                            </span>
                                        </button>
                                    </li>
                                    <li className="relative">
                                        <button onClick={() => document.getElementById('intro-pipeline')?.scrollIntoView({ behavior: 'smooth' })} className="flex items-center gap-4 group w-full text-left">
                                            <div className={`h-3 w-3 rounded-full border-2 border-[#8D7B68] z-10 shrink-0 transition-colors ${activeSection === 'intro-pipeline' ? 'bg-[#8D7B68]' : 'bg-white group-hover:bg-[#8D7B68]'}`}></div>
                                            <span className={`transition-all text-sm tracking-widest uppercase ${activeSection === 'intro-pipeline' ? 'text-[#4A4743] font-bold' : 'text-[#8D7B68] group-hover:text-[#4A4743] group-hover:font-bold'}`}>
                                                2. Pipeline
                                            </span>
                                        </button>
                                    </li>
                                    <li className="relative">
                                        <button onClick={() => document.getElementById('intro-engineering')?.scrollIntoView({ behavior: 'smooth' })} className="flex items-center gap-4 group w-full text-left">
                                            <div className={`h-3 w-3 rounded-full border-2 border-[#8D7B68] z-10 shrink-0 transition-colors ${activeSection === 'intro-engineering' ? 'bg-[#8D7B68]' : 'bg-white group-hover:bg-[#8D7B68]'}`}></div>
                                            <span className={`transition-all text-sm tracking-widest uppercase ${activeSection === 'intro-engineering' ? 'text-[#4A4743] font-bold' : 'text-[#8D7B68] group-hover:text-[#4A4743] group-hover:font-bold'}`}>
                                                3. Decisions
                                            </span>
                                        </button>
                                    </li>
                                    <li className="relative">
                                        <button onClick={() => document.getElementById('intro-limitations')?.scrollIntoView({ behavior: 'smooth' })} className="flex items-center gap-4 group w-full text-left">
                                            <div className={`h-3 w-3 rounded-full border-2 border-[#8D7B68] z-10 shrink-0 transition-colors ${activeSection === 'intro-limitations' ? 'bg-[#8D7B68]' : 'bg-white group-hover:bg-[#8D7B68]'}`}></div>
                                            <span className={`transition-all text-sm tracking-widest uppercase ${activeSection === 'intro-limitations' ? 'text-[#4A4743] font-bold' : 'text-[#8D7B68] group-hover:text-[#4A4743] group-hover:font-bold'}`}>
                                                4. Limitations
                                            </span>
                                        </button>
                                    </li>
                                    <li className="relative">
                                        <button onClick={() => document.getElementById('intro-learned')?.scrollIntoView({ behavior: 'smooth' })} className="flex items-center gap-4 group w-full text-left">
                                            <div className={`h-3 w-3 rounded-full border-2 border-[#8D7B68] z-10 shrink-0 transition-colors ${activeSection === 'intro-learned' ? 'bg-[#8D7B68]' : 'bg-white group-hover:bg-[#8D7B68]'}`}></div>
                                            <span className={`transition-all text-sm tracking-widest uppercase ${activeSection === 'intro-learned' ? 'text-[#4A4743] font-bold' : 'text-[#8D7B68] group-hover:text-[#4A4743] group-hover:font-bold'}`}>
                                                5. Reflections
                                            </span>
                                        </button>
                                    </li>
                                </ul>
                            </div>
                        </div>
                    </div>
                )}

                {/* 视图2：主页词卡 */}
                {currentView === 'home' && (
                    <div className="p-6 md:p-12 h-full overflow-y-auto w-full animate-in fade-in duration-500">
                        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-6 md:mb-10 border-b pb-4 border-[#EAE5D9] gap-4">
                            <h2 className="text-xl md:text-2xl font-bold tracking-widest text-[#4A4743]">YOUR UNIVERSES</h2>
                            <div className="flex flex-wrap items-center gap-3">
                                <a
                                    href="https://github.com/Ray-gyr/storyAI"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#FAFAF8] border border-[#D8D3C4] text-[#8D7B68] hover:text-[#4A4743] hover:bg-[#F2F0E9] hover:border-[#8D7B68] transition-all text-sm font-bold tracking-widest shadow-sm hover:shadow group w-fit"
                                >
                                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" className="group-hover:scale-110 transition-transform">
                                        <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
                                    </svg>
                                    GITHUB
                                </a>
                            </div>
                        </div>
                        <div className="grid grid-cols-2 xl:grid-cols-3 gap-4 md:gap-8">
                            {isClient && savedSessions.map((session, index) => (
                                <div
                                    key={session.id}
                                    onClick={() => loadSessionChat(session.id)}
                                    onPointerDown={(e) => handlePointerDown(session.id, e)}
                                    onPointerUp={() => clearPointerTimer(session.id)}
                                    onPointerLeave={() => clearPointerTimer(session.id)}
                                    onPointerCancel={() => clearPointerTimer(session.id)}
                                    onContextMenu={(e) => e.preventDefault()}
                                    className="select-none bg-white border border-[#EAE5D9] rounded-xl p-4 md:p-8 hover:shadow-xl hover:border-[#8D7B68] transition-all cursor-pointer group relative h-48 md:h-64 flex flex-col justify-between"
                                >
                                    <div>
                                        <h3 className="text-sm md:text-xl font-bold text-[#4A4743] tracking-widest mb-2 md:mb-3 line-clamp-3 break-words leading-snug" title={session.title}>{session.title}</h3>
                                        {session.style && session.style !== "UNKNOWN" && (
                                            <p className="text-[10px] md:text-xs text-[#5C554B] font-bold bg-[#F2F0E9] border border-[#EAE5D9] inline-block px-2 py-0.5 md:px-3 md:py-1 rounded tracking-widest uppercase">{session.style}</p>
                                        )}
                                    </div>
                                    <div className="flex justify-between items-end">
                                        <span className="text-[#8D7B68] text-[10px] md:text-sm group-hover:underline decoration-dotted tracking-widest">ENTER →</span>
                                        <button
                                            onClick={(e) => handleDeleteSession(session.id, e)}
                                            className="hidden md:block text-red-300 hover:text-red-500 text-sm tracking-widest opacity-0 group-hover:opacity-100 transition-opacity"
                                        >
                                            DELETE
                                        </button>
                                    </div>
                                </div>
                            ))}

                            {isClient && savedSessions.length === 0 && (
                                <div
                                    onClick={loading ? undefined : handleStartDefaultStory}
                                    className={`bg-[#4A4743] border border-[#2C2B29] rounded-xl p-4 md:p-8 transition-all group relative h-48 md:h-64 flex flex-col justify-between ${loading ? 'opacity-50 cursor-not-allowed' : 'hover:shadow-xl hover:-translate-y-1 cursor-pointer'}`}
                                >
                                    <div>
                                        <h3 className="text-sm md:text-xl font-bold text-[#FDFBF7] tracking-widest mb-2">Default: Apocalypse Rebirth</h3>
                                        <p className="text-[10px] md:text-sm text-[#D8D3C4] italic mt-1 md:mt-2 leading-relaxed line-clamp-3 md:line-clamp-none">
                                            You once struggled in the abyss apocalypse for ten years, betrayed by your comrades. Now you suddenly open your eyes and find yourself reborn 30 days before the disaster...
                                        </p>
                                    </div>
                                    <div className="flex justify-between items-end">
                                        <span className={`text-[#FAFAF8] text-[10px] md:text-sm tracking-widest font-bold ${loading ? '' : 'group-hover:underline decoration-dotted'}`}>
                                            {loading ? 'WEAVING...' : 'ENTER →'}
                                        </span>
                                    </div>
                                </div>
                            )}

                            {isClient && savedSessions.length < 3 && (
                                <div
                                    onClick={() => setCurrentView('new_story')}
                                    className="border-2 border-dashed border-[#D8D3C4] rounded-xl p-4 md:p-8 hover:bg-[#FAFAF8] hover:border-[#8D7B68] transition-all cursor-pointer flex flex-col items-center justify-center h-48 md:h-64 text-[#8D7B68]"
                                >
                                    <span className="text-3xl md:text-5xl mb-2 md:mb-4 font-light">+</span>
                                    <span className="text-xs md:text-base tracking-[0.2em] font-bold text-center">NEW UNIVERSE</span>
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
                    <div className="p-6 md:p-12 w-full max-w-4xl mx-auto h-full overflow-y-auto animate-in fade-in zoom-in duration-500">
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
                                    <div className="flex justify-between items-center">
                                        <label className="block text-sm font-medium text-[#5C554B] tracking-widest uppercase">Story Setting / World Background</label>
                                        <button
                                            type="button"
                                            onClick={() => setStorySetting(DEFAULT_STORY_SETTING)}
                                            className="text-xs text-[#8D7B68] hover:text-[#4A4743] transition-colors underline decoration-dotted tracking-widest"
                                        >
                                            INJECT DEFAULT
                                        </button>
                                    </div>
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
                    <div className="flex-1 flex flex-col h-full bg-white relative animate-in fade-in duration-500 min-w-0">
                        <div className="py-4 sm:py-5 px-4 sm:px-6 border-b border-[#EAE5D9] bg-[#FAFAF8] flex justify-between items-center relative z-10 gap-2 sm:gap-4">
                            <button
                                onClick={() => { setCurrentView('home'); setActiveSessionId(null); }}
                                className="inline-flex items-center gap-1 sm:gap-2 px-3 py-1.5 sm:px-4 sm:py-2 rounded-lg bg-white border border-[#D8D3C4] text-[#8D7B68] hover:text-[#4A4743] hover:bg-[#F2F0E9] hover:border-[#8D7B68] transition-all text-[10px] sm:text-sm font-bold tracking-[0.2em] shadow-sm hover:shadow group shrink-0"
                            >
                                <span className="group-hover:-translate-x-1 transition-transform">←</span> LEAVE
                            </button>
                            <h1 className="text-sm sm:text-lg font-bold tracking-[0.2em] sm:tracking-[0.3em] text-[#4A4743] truncate flex-1 text-center uppercase min-w-0">
                                [ {savedSessions.find(s => s.id === activeSessionId)?.title || activeSessionId} ]
                            </h1>
                            <Link
                                href={`/detail?sessionId=${activeSessionId}${fromParam ? `&from=${fromParam}` : ''}`}
                                onClick={() => {
                                    if (activeSessionId && messages.length > 0) {
                                        sessionStorage.setItem(
                                            `chat_snapshot_${activeSessionId}`,
                                            JSON.stringify(messages)
                                        );
                                    }
                                }}
                                className="inline-flex items-center gap-1 sm:gap-2 px-3 py-1.5 sm:px-4 sm:py-2 rounded-lg bg-white border border-[#D8D3C4] text-[#8D7B68] hover:text-[#4A4743] hover:bg-[#F2F0E9] hover:border-[#8D7B68] transition-all text-[10px] sm:text-sm font-bold tracking-[0.2em] shadow-sm hover:shadow group shrink-0"
                            >
                                DETAIL <span className="group-hover:translate-x-1 transition-transform">→</span>
                            </Link>
                        </div>

                        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 sm:p-12 space-y-6 sm:space-y-10 scroll-smooth custom-scrollbar bg-[url('https://www.transparenttextures.com/patterns/cream-paper.png')]">
                            {messages.map((m, i) => (
                                <div key={i} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                                    <div
                                        className={`max-w-[95%] sm:max-w-[80%] leading-relaxed sm:leading-loose tracking-wide text-sm sm:text-lg text-[#2C2B29] bg-white bg-opacity-90 p-4 sm:p-8 rounded shadow-sm border border-[#EAE5D9] transition-all ${m.role === 'user' ? 'text-[#5C554B]' : ''}`}
                                        style={m.role === 'assistant' ? { textIndent: '1.5em' } : {}}
                                    >
                                        {m.role === 'assistant' && m.content === '' && loading && i === messages.length - 1 ? (
                                            <UnfoldingMessage />
                                        ) : (
                                            m.content.split('\n').filter(line => line.trim() !== '').map((line, idx) => (
                                                <p key={idx} className="mb-3 last:mb-0 min-h-[1.5rem]">{line}</p>
                                            ))
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>

                        <div className="p-3 sm:p-6 bg-[#FAFAF8] border-t border-[#EAE5D9] z-10 relative shadow-[0_-10px_30px_rgba(0,0,0,0.03)] pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-6">
                            <form onSubmit={handleSubmit} className="flex gap-2 sm:gap-4 max-w-5xl mx-auto items-center">
                                <input
                                    type="text"
                                    className="flex-1 bg-white border-b-2 border-[#EAE5D9] focus:border-[#8D7B68] outline-none px-3 sm:px-4 py-2 sm:py-3 text-base sm:text-xl placeholder-gray-300 transition-colors min-w-0"
                                    placeholder={loading ? "Calculating..." : "Where will you go?"}
                                    value={input}
                                    onChange={e => setInput(e.target.value)}
                                    disabled={loading}
                                />
                                <button
                                    type="submit"
                                    disabled={loading || !input.trim()}
                                    className="px-4 sm:px-8 py-2 sm:py-3 text-sm sm:text-base bg-[#4A4743] hover:bg-[#2C2B29] text-white font-bold tracking-[0.2em] rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed uppercase shrink-0"
                                >
                                    ACT
                                </button>
                            </form>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
