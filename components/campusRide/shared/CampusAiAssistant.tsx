"use client";

import { useState } from "react";

export function CampusAiAssistant({ area, context, placeholder = "Ask for help with this campusRide area..." }: { area: "student" | "driver" | "admin"; context: string; placeholder?: string }) {
  const [prompt, setPrompt] = useState("");
  const [response, setResponse] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const ask = async () => {
    setLoading(true); setError(""); setResponse("");
    try {
      const result = await fetch("/api/campus/ai", { method:"POST", headers:{"content-type":"application/json"}, credentials:"same-origin", body:JSON.stringify({ area, context, prompt }) });
      const data = await result.json();
      if (!result.ok) throw new Error(data.error || "AI help failed.");
      setResponse(data.suggestion || "No suggestion returned.");
    } catch (askError) {
      setError(askError instanceof Error ? askError.message : "AI help failed.");
    } finally {
      setLoading(false);
    }
  };

  return <section className="campus-ai-widget">
    <div><p>AI HELP</p><h3>{area === "student" ? "Ride helper" : area === "driver" ? "Driver assistant" : "Admin assistant"}</h3></div>
    <textarea value={prompt} onChange={(event)=>setPrompt(event.target.value)} placeholder={placeholder} />
    <button onClick={ask} disabled={loading}>{loading ? "Thinking..." : "Ask AI"}</button>
    {response && <p className="campus-ai-response">{response}</p>}
    {error && <p className="campus-ai-error">{error}</p>}
  </section>;
}

