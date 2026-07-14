export { PollerDO } from './PollerDO.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (['/start', '/stop', '/status'].includes(url.pathname)) {
      const id = env.OHLCV_DO.idFromName('main');
      return env.OHLCV_DO.get(id).fetch(request);
    }
    return new Response('live-lf worker. Endpoints: /start /stop /status');
  },
};