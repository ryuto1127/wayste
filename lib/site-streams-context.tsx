"use client";

import { createContext, useContext, useEffect, useState } from "react";

export interface SiteStreamDef {
  id: string;
  label: string;
  color: string;
}

const SiteStreamsContext = createContext<SiteStreamDef[]>([]);

export function SiteStreamsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [streams, setStreams] = useState<SiteStreamDef[]>([]);

  useEffect(() => {
    fetch("/api/site-config")
      .then((r) => r.json())
      .then((d: { streams?: SiteStreamDef[] }) => {
        if (d.streams) setStreams(d.streams);
      })
      .catch(() => {});
  }, []);

  return (
    <SiteStreamsContext.Provider value={streams}>
      {children}
    </SiteStreamsContext.Provider>
  );
}

export function useSiteStreams() {
  return useContext(SiteStreamsContext);
}
