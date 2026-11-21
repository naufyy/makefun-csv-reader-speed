// Preload (node --import): prints the process's CPU seconds (user+sys, every thread) on exit to stderr.
process.on('exit', () => { const u = process.cpuUsage(); process.stderr.write(`CPU ${((u.user + u.system) / 1e6).toFixed(3)}\n`); });
