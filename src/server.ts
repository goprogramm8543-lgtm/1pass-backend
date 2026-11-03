import { config } from './config/index.js';
import { postgres } from './infrastructure/db/index.js';
import { buildApp } from './app.js';
const c=config(),db=postgres(c.DATABASE_URL),app=buildApp(c,db);
for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{void app.close().then(()=>db.close());});
await app.listen({port:c.PORT,host:c.HOST});
