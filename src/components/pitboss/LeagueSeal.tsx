"use client";

import { useState } from "react";

interface LeagueSealProps {
  name: string;
  slug: string;
  logoUrl?: string | null;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const SIZE_STYLES: Record<NonNullable<LeagueSealProps["size"]>, string> = {
  sm: "h-10 w-10 text-xs",
  md: "h-16 w-16 text-base",
  lg: "h-24 w-24 text-2xl",
};

function initials(slug: string): string {
  return slug.replace(/[^a-zA-Z0-9]/g, "").slice(0, 3).toUpperCase();
}

export default function LeagueSeal({
  name,
  slug,
  logoUrl,
  size = "md",
  className = "",
}: LeagueSealProps) {
  const [imgFailed, setImgFailed] = useState(false);
  const showImage = logoUrl && !imgFailed;

  return (
    <div
      role="img"
      aria-label={`${name} league seal`}
      className={`relative inline-flex items-center justify-center rounded-full ${SIZE_STYLES[size]} ${className}`}
    >
      {/* Outer ring — gives it the "official seal" look */}
      <div className="absolute inset-0 rounded-full ring-2 ring-amber-400/40 ring-offset-2 ring-offset-zinc-950" />
      <div className="absolute inset-[3px] rounded-full ring-1 ring-amber-300/20" />

      <div className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-full bg-zinc-900">
        {showImage ? (
          <img
            src={logoUrl}
            alt={`${name} logo`}
            className="h-full w-full object-cover"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <span className="font-bold tracking-wide text-amber-300">
            {initials(slug)}
          </span>
        )}
      </div>
    </div>
  );
}
