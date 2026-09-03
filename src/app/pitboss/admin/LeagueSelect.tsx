// src/app/pitboss/admin/cap-status/LeagueSelect.tsx
//
// Small client component so the dropdown can navigate on change without
// a submit button. Kept separate from page.tsx because page.tsx is a
// server component (does the Supabase fetch) and a file can't mix
// "use client" with server-side data fetching.
"use client";

import { useRouter } from "next/navigation";

type LeagueOption = {
  id: string;
  name: string;
  slug: string;
};

export default function LeagueSelect({
  leagues,
  selectedSlug,
}: {
  leagues: LeagueOption[];
  selectedSlug: string;
}) {
  const router = useRouter();

  return (
    <select
      value={selectedSlug}
      onChange={(e) => {
        router.push(`/pitboss/admin/cap-status?league=${e.target.value}`);
      }}
      className="rounded-sm border border-[#232428] bg-[#131417] px-3 py-1.5 text-sm text-[#EDEDEE] focus:outline-none focus:ring-1 focus:ring-[#3A3C42]"
    >
      {leagues.map((l) => (
        <option key={l.id} value={l.slug}>
          {l.name}
        </option>
      ))}
    </select>
  );
}
