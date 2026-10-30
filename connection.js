// A reconnecting transport. Terminal input is deliberately never queued/replayed.
class TmuxConnection {
  constructor({token, socketURL, resolveToken}) {
    this.token = token;
    this.socketURL = socketURL;
    this.resolveToken = resolveToken;
    this.handlers = new Map();
    this.requests = new Set();
    this.socket = null;
    this.state = 'offline';
    this.generation = 0;
    this.attempts = 0;
    this.sequence = 0;
    this.lastPing = 0;
    this.pendingPing = null;
    this.running = false;
    this.retryTimer = null;
    this.openTimer = null;
    this.monitor = null;
  }

  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(fn);
    return () => this.handlers.get(event)?.delete(fn);
  }

  emit(event, ...args) {
    for (const fn of this.handlers.get(event) || []) fn(null, ...args);
  }

  get online() { return this.state === 'online' && this.socket?.readyState === 1; }

  send(event, ...args) {
    if (!this.online) return false;
    if (this.pendingPing && Date.now() - this.pendingPing.sent > 10000) {
      this.disconnect();
      return false;
    }
    try {
      this.socket.send(JSON.stringify({event, args}));
      return true;
    } catch {
      this.disconnect();
      return false;
    }
  }

  invoke(event) {
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (error, value) => {
        clearTimeout(timer);
        off();
        this.requests.delete(cancel);
        error ? reject(error) : resolve(value);
      };
      const off = this.on(event, (_, value) => finish(null, value));
      const cancel = () => finish(new Error('连接正在恢复'));
      this.requests.add(cancel);
      timer = setTimeout(() => finish(new Error('连接响应超时')), 10000);
      if (!this.send(event)) cancel();
    });
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('transport', state);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.monitor = setInterval(() => this.check(), 5000);
    this.open();
  }

  async open() {
    if (!this.running || this.socket || this.state === 'connecting') return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const generation = ++this.generation;
    this.setState('connecting');
    // Includes token refresh, so even a stalled HTTP request cannot block recovery.
    this.openTimer = setTimeout(() => {
      if (generation === this.generation) this.disconnect();
    }, 10000);
    try {
      if (this.attempts || !this.token) this.token = await this.resolveToken();
      if (!this.running || generation !== this.generation) return;
      const socket = this.socket = new WebSocket(this.socketURL + '?token=' + encodeURIComponent(this.token));
      socket.onopen = () => {
        if (generation !== this.generation) return;
        clearTimeout(this.openTimer);
        this.pendingPing = null;
        this.lastPing = 0;
        this.setState('online');
        this.check(true);
      };
      socket.onmessage = event => {
        if (generation !== this.generation) return;
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (!Array.isArray(message.args)) return;
        if (message.event === 'pong') {
          if (message.args[0] === this.pendingPing?.id) {
            this.pendingPing = null;
            this.attempts = 0;
          }
          return;
        }
        this.emit(message.event, ...message.args);
      };
      socket.onclose = socket.onerror = () => {
        if (generation === this.generation) this.disconnect();
      };
    } catch {
      if (generation === this.generation) this.disconnect();
    }
  }

  disconnect() {
    if (!this.running) return;
    ++this.generation;
    clearTimeout(this.openTimer);
    clearTimeout(this.retryTimer);
    const socket = this.socket;
    this.socket = null;
    this.pendingPing = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try { socket.close(); } catch {}
    }
    for (const cancel of [...this.requests]) cancel();
    this.setState('reconnecting');
    const delay = Math.min(15000, 1000 * 2 ** Math.min(this.attempts++, 4));
    this.retryTimer = setTimeout(() => this.open(), delay);
  }

  check(force = false) {
    if (!this.online) return;
    const now = Date.now();
    if (this.pendingPing) {
      if (now - this.pendingPing.sent > 10000) this.disconnect();
      return;
    }
    if (force || now - this.lastPing >= 15000) {
      const id = String(++this.sequence);
      this.pendingPing = {id, sent: now};
      this.lastPing = now;
      this.send('ping', id);
    }
  }

  wake() {
    if (!this.running) return;
    if (this.online) this.check(true);
    else if (this.state !== 'connecting') this.open();
  }

  stop() {
    this.running = false;
    ++this.generation;
    clearTimeout(this.retryTimer);
    clearTimeout(this.openTimer);
    clearInterval(this.monitor);
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try { socket.close(); } catch {}
    }
    for (const cancel of [...this.requests]) cancel();
    this.setState('offline');
  }
}

if (typeof module !== 'undefined') module.exports = TmuxConnection;
