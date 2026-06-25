  {/* User Card */}
  <div className="rounded-2xl border border-white/10 bg-white/5 p-6 mb-6">
    <div className="flex items-center gap-4">
      {user?.image && (
        <img
          src={user.image}
          alt="avatar"
          className="h-14 w-14 rounded-full border-2 border-rise-red"
        />
      )}
      <div>
        <p className="text-white font-bold text-lg">
          {user?.username || user?.name}
        </p>
        <p className="text-white/40 text-sm">
          {user?.email}
        </p>
        <p className="text-rise-red text-xs mt-1 font-medium uppercase tracking-wide">
          Commissioner
        </p>
      </div>
    </div>
  </div>

  {/* Module Grid */}
  <p className="text-white/30 text-xs uppercase tracking-widest mb-3">
    Modules
  </p>
  <div className="grid grid-cols-2 gap-3">
    {[
      { name: "Governance", icon: "⚖️", status: "Soon" },
      { name: "Franchise", icon: "🏟️", status: "Soon" },
      { name: "Season Ops", icon: "📅", status: "Soon" },
      { name: "Draft", icon: "📋", status: "Soon" },
      { name: "Discord", icon: "💬", status: "Soon" },
      { name: "Coaching", icon: "🎯", status: "Soon" },
    ].map((module) => (
      <div
        key={module.name}
        className="rounded-xl border border-white/10 bg-white/5 p-4 flex flex-col gap-2"
      >
        <span className="text-2xl">{module.icon}</span>
        <p className="text-sm font-semibold text-white">{module.name}</p>
        <span className="text-xs text-white/30">{module.status}</span>
      </div>
    ))}
  </div>

  {/* Footer */}
  <p className="text-center text-xs text-white/20 mt-10">
    TOPS Ecosystem · Rise OS v0.1
  </p>
</main>
