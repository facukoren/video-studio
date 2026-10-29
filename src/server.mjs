process.umask(0o077);
import path from 'node:path';
import {loadConfig} from './config.mjs';import {Store} from './store.mjs';import {createApp} from './app.mjs';
import {DriveClient} from './providers/drive.mjs';import {HiggsfieldClient} from './providers/higgsfield.mjs';import {makeStatus} from './status.mjs';
const config=loadConfig(),store=new Store(path.join(config.dataDir,'studio.sqlite'),{destinationFolderId:config.destinationFolderId});
const drive=new DriveClient(config),higgs=new HiggsfieldClient(config);
const integrationStatus=makeStatus({config,store,drive,higgs});
const app=createApp({store,config:{...config,driveClient:drive},integrationStatus});
const server=app.listen(config.port,config.host,()=>console.log(`Kavion Videos disponible en ${config.baseUrl}`));
server.requestTimeout=30*60*1000; // Allow large private video uploads; headers retain their default timeout.
const shutdown=()=>{app.locals.higgsfieldSetup?.close();server.close(()=>{store.close();process.exit(0);});};process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
