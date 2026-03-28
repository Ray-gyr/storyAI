'use client';
import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';

function DebugPanel() {
    const searchParams = useSearchParams();
    const sessionId = searchParams.get('sessionId');
    const [data, setData] = useState<any>(null);

    useEffect(() => {
        if (!sessionId) return;
        
        const fetchDebug = async () => {
            try {
                const res = await fetch(`/api/debug?sessionId=${sessionId}`);
                const json = await res.json();
                setData(json);
            } catch(e) {
                console.error(e);
            }
        };

        fetchDebug();
        // 每 3 秒自动轮询一次刷新最新数据
        const interval = setInterval(fetchDebug, 3000);
        return () => clearInterval(interval);
    }, [sessionId]);

    if (!sessionId) {
        return <div className="p-10 font-sans text-center text-gray-500">Missing sessionId parameter. Please go back to the main game to start a session.</div>;
    }

    return (
        <div className="min-h-screen bg-[#FDFBF7] text-[#333] font-sans p-8">
            <h1 className="text-2xl font-bold mb-6 text-[#4A4743] border-b border-[#D8D3C4] pb-3 tracking-wider">
                GOD'S EYE MONITORING PANEL <span className="text-sm font-normal text-gray-400">({sessionId})</span>
            </h1>
            
            {!data ? <div className="text-[#8D7B68] animate-pulse">Connecting to the Divine Network...</div> : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    
                    <div className="bg-white border border-[#EAE5D9] shadow-sm rounded-md p-5">
                        <div className="flex justify-between items-center mb-3">
                            <h2 className="text-lg font-semibold text-amber-900 tracking-wide">Current State (Book of God)</h2>
                            <span className="text-xs text-gray-400 bg-gray-100 px-2 py-1 rounded">Diff Update Layer</span>
                        </div>
                        <pre className="text-xs sm:text-sm text-gray-700 bg-[#F9F8F5] p-4 rounded overflow-auto max-h-[600px] border border-[#f0eee9]">
                            {JSON.stringify(data.currentState, null, 2)}
                        </pre>
                    </div>

                    <div className="bg-white border border-[#EAE5D9] shadow-sm rounded-md p-5">
                        <div className="flex justify-between items-center mb-3">
                            <h2 className="text-lg font-semibold text-emerald-900 tracking-wide">Pinecone Vector DB (Long-term Memory)</h2>
                            <span className="text-xs text-gray-400 bg-gray-100 px-2 py-1 rounded">RAG Cloud Layer</span>
                        </div>
                        <pre className="text-xs sm:text-sm text-gray-700 bg-[#F9F8F5] p-4 rounded overflow-auto max-h-[600px] border border-[#f0eee9]">
                            {data.pineconeError ? `[Error]: ${data.pineconeError}` : JSON.stringify(data.pineconeRecords, null, 2)}
                        </pre>
                    </div>

                    <div className="bg-white border border-[#EAE5D9] shadow-sm rounded-md p-5">
                        <div className="flex justify-between items-center mb-3">
                            <h2 className="text-lg font-semibold text-blue-900 tracking-wide">Chat History (Short-term Context)</h2>
                            <span className="text-xs text-gray-400 bg-gray-100 px-2 py-1 rounded">10-turn Sliding Window</span>
                        </div>
                        <pre className="text-xs sm:text-sm text-gray-700 bg-[#F9F8F5] p-4 rounded overflow-auto max-h-[400px] border border-[#f0eee9]">
                            {JSON.stringify(data.chatHistory, null, 2)}
                        </pre>
                    </div>

                     <div className="bg-white border border-[#EAE5D9] shadow-sm rounded-md p-5">
                        <div className="flex justify-between items-center mb-3">
                            <h2 className="text-lg font-semibold text-purple-900 tracking-wide">Unprocessed Archive (Raw Workspace)</h2>
                            <span className="text-xs text-gray-400 bg-gray-100 px-2 py-1 rounded">Awaiting LLM Processing</span>
                        </div>
                        <pre className="text-xs sm:text-sm text-gray-700 bg-[#F9F8F5] p-4 rounded overflow-auto max-h-[400px] border border-[#f0eee9]">
                            {JSON.stringify(data.unprocessedArchive, null, 2)}
                        </pre>
                    </div>

                </div>
            )}
        </div>
    );
}

export default function DebugPage() {
    return (
        <Suspense fallback={<div className="p-10">Loading...</div>}>
            <DebugPanel />
        </Suspense>
    );
}
