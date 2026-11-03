import type { Sql } from '../infrastructure/db/index.js';
export async function allowance(db:Sql,key:string,max:number,seconds:number):Promise<boolean> {
 const row=(await db.query<{hits:number}>(`INSERT INTO marketing_rate_limits(key,hits,reset_at) VALUES($1,1,now()+$2*interval '1 second')
 ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN marketing_rate_limits.reset_at<=now() THEN 1 ELSE marketing_rate_limits.hits+1 END,
 reset_at=CASE WHEN marketing_rate_limits.reset_at<=now() THEN excluded.reset_at ELSE marketing_rate_limits.reset_at END RETURNING hits`,[key,seconds])).rows[0]!;
 return row.hits<=max;
}
