export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-rise-black px-6">
      {/* Logo Area */}
      <div className="mb-8 flex flex-col items-center gap-2">
        <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-rise-red">
          <span className="text-3xl font-black text-white">R</span>
        </div>
        <h1 className="text-4xl font-black tracking-tight text-white">
          Rise <span className="text-rise-red">OS</span>
        </h1>
        <p className="text-sm text-white/50 tracking-widest uppercase">
          Sports Dynasty Governance
        </p>
      </div>

      {/* Status */}
      <div className="mb-12 rounded-full border border-rise-red/30 bg-rise-red/10 px-4 py-2">
        <p className="text-xs text-rise-red font-medium tracking-wide uppercase">
          System Initializing
        </p>
      </div>

      {/* Module Grid */}
      <div className="grid grid-cols-2 gap-3 w-full max-w-sm">
        {[
          { name: "Governance", status: "Coming Soon" },
          { name: "Franchise", status: "Coming Soon" },
          { name: "Season Ops", status: "Coming Soon" },
          { name: "Draft", status: "Coming Soon" },
          { name: "Discord", status: "Coming Soon" },
          { name: "Coaching", status: "Coming Soon" },
        ].map((module) => (
          <div
            key={module.name}
            className="rounded-xl border border-white/10 bg-white/5 p-4"
          >
            <p className="text-sm font-semibold text-white">{module.name}</p>
            <p className="text-xs text-white/30 mt-1">{module.status}</p>
          </div>
        ))}
      </div>

      {/* Footer */}
      <p className="mt-12 text-xs text-white/20">
        TOPS Ecosystem · Rise OS v0.1
      </p>
    </main>
  );
}
