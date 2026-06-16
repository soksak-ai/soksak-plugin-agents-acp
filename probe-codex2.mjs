import * as acp from "@zed-industries/agent-client-protocol";
import { spawn } from "node:child_process";
import { Writable, Readable } from "node:stream";
const child = spawn("codex", ["acp"], { stdio: ["pipe","pipe","pipe"], env: {...process.env, CLAUDECODE: undefined} });
let stderr=""; child.stderr.on("data",d=>stderr+=d.toString());
child.on("error",e=>{console.log("SPAWN ERR:",String(e));process.exit(3);});
const stream=acp.ndJsonStream(Writable.toWeb(child.stdin),Readable.toWeb(child.stdout));
const client={async sessionUpdate(){},async requestPermission(){return {outcome:{outcome:"cancelled"}};},async readTextFile(){return{content:""};},async writeTextFile(){return{};}};
const conn=new acp.ClientSideConnection(()=>client,stream);
const kill=setTimeout(()=>{console.log("TIMEOUT 12s (인증 필요 가능)");console.log("stderr:",stderr.slice(0,400));child.kill("SIGKILL");process.exit(2);},12000);
try{
  const init=await conn.initialize({protocolVersion:acp.PROTOCOL_VERSION,clientCapabilities:{fs:{readTextFile:true,writeTextFile:true}}});
  console.log("INIT OK:",JSON.stringify(init).slice(0,200));
  const s=await conn.newSession({cwd:process.cwd(),mcpServers:[]});
  clearTimeout(kill);
  console.log("SESSION OK:",JSON.stringify(s).slice(0,150));
  child.kill("SIGKILL");process.exit(0);
}catch(e){clearTimeout(kill);console.log("ERR:",String(e).slice(0,200));console.log("stderr:",stderr.slice(0,400));child.kill("SIGKILL");process.exit(1);}
