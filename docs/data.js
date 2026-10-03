export const DAYS=['月','火','水','木','金','土','日'];
export const SOURCE_URLS={manaba:'https://room.chuo-u.ac.jp/ct/home',campusSquare:'https://portal.cs.chuo-u.ac.jp/campusweb/',syllabus:'https://portal.cs.chuo-u.ac.jp/campusweb/campussquare.do?_flowId=SBW3701300-flow'};
export const STATE_SCHEMA=2;
export const emptyState=()=>({schemaVersion:STATE_SCHEMA,revision:0,courses:[],tasks:[],pages:[],updatedAt:null,preferences:{lastBackupAt:null}});
const text=(v,max=500)=>typeof v==='string'?v.trim().slice(0,max):'';
const array=(v,max=5000)=>Array.isArray(v)?v.slice(0,max):[];
export function safeURL(value){
  try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443')||!['room.chuo-u.ac.jp','portal.cs.chuo-u.ac.jp','syllabus.chuo-u.ac.jp'].includes(u.hostname))return '';
    if(u.hostname==='portal.cs.chuo-u.ac.jp')return SOURCE_URLS.syllabus;
    u.hash='';u.search='';u.pathname=u.pathname.replace(/;(?:jsessionid|sessionid)=[^/;?]*/gi,'');return u.href;
  }catch{return '';}
}
export function slots(value){return array(value,100).filter(s=>Number.isInteger(s.day)&&s.day>=1&&s.day<=7&&Number.isInteger(s.period)&&s.period>=1&&s.period<=9).map(s=>({day:s.day,period:s.period})).filter((s,i,a)=>a.findIndex(x=>x.day===s.day&&x.period===s.period)===i);}
function date(v){if(!v)return null;return typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():null;}
export function validateCapture(raw){
  if(raw?.error)throw new Error(text(raw.error));
  if(raw?.kind!=='chuo-pocket-capture'||raw.schemaVersion!==1||!['manaba','campusSquare'].includes(raw.source))throw new Error('取り込み用ショートカットで取得したデータを貼り付けてください。');
  const capturedAt=date(raw.capturedAt);if(!capturedAt)throw new Error('取得時刻を確認できません。もう一度取り込んでください。');
  const sourceURL=safeURL(raw.sourceURL);if(!sourceURL||new URL(sourceURL).hostname!==(raw.source==='manaba'?'room.chuo-u.ac.jp':'portal.cs.chuo-u.ac.jp'))throw new Error('公式ページの出典を確認できません。');
  const courses=array(raw.courses,1000).map(c=>({sourceId:text(c.sourceId,120),title:text(c.title),slots:slots(c.slots),room:text(c.room),campus:text(c.campus),instructor:text(c.instructor),term:text(c.term,120),url:safeURL(c.url)})).filter(c=>c.sourceId&&c.title);
  const tasks=array(raw.tasks).map(t=>({sourceId:text(t.sourceId,150),title:text(t.title),sourceCourseId:text(t.sourceCourseId,120),courseTitle:text(t.courseTitle),dueAt:date(t.dueAt),url:safeURL(t.url)})).filter(t=>t.sourceId&&t.title);
  const pages=array(raw.pages,1000).map(p=>({sourceId:text(p.sourceId,150),title:text(p.title),courseCode:text(p.courseCode,80),year:text(String(p.year??''),20),term:text(p.term,120),room:text(p.room),campus:text(p.campus),instructor:text(p.instructor),slots:slots(p.slots),bodyText:text(p.bodyText,100000),url:safeURL(p.url)||sourceURL})).filter(p=>p.sourceId&&p.title&&p.bodyText);
  if(!courses.length&&!tasks.length&&!pages.length&&raw.emptyTasks!==true)throw new Error('対応する時間割・課題・シラバスが見つかりませんでした。');
  return{source:raw.source,sourceURL,capturedAt,courses,tasks,pages,emptyTasks:raw.emptyTasks===true};
}
export function mergeCapture(state,capture,{courseIds,taskIds,pageIds,pageLinks}={}){
  const next=structuredClone(state);const now=new Date().toISOString();const wanted=(set,id)=>!set||set.has(id);
  for(const c of capture.courses.filter(c=>wanted(courseIds,c.sourceId))){
    const existing=next.courses.find(x=>x.sourceId===c.sourceId);if(existing){existing.slots=c.slots;existing.title=c.title;existing.url=c.url||existing.url;existing.updatedAt=capture.capturedAt;}
    else next.courses.push({...c,id:crypto.randomUUID(),source:capture.source,updatedAt:capture.capturedAt,notes:''});
  }
  for(const task of next.tasks){if(!task.courseId&&task.sourceCourseId)task.courseId=next.courses.find(c=>c.sourceId===task.sourceCourseId)?.id||null;}
  for(const t of capture.tasks.filter(t=>wanted(taskIds,t.sourceId))){
    const existing=next.tasks.find(x=>x.sourceId===t.sourceId);const courseId=next.courses.find(x=>x.sourceId===t.sourceCourseId)?.id||null;
    if(existing)Object.assign(existing,t,{courseId:courseId||existing.courseId,updatedAt:capture.capturedAt});
    else next.tasks.push({...t,id:crypto.randomUUID(),courseId,isCompleted:false,notes:'',source:capture.source,updatedAt:capture.capturedAt});
  }
  for(const p of capture.pages.filter(p=>wanted(pageIds,p.sourceId))){
    const chosen=pageLinks?.[p.sourceId]||null;
    let course=next.courses.find(c=>c.id===chosen);
    if(chosen==='new'){course={id:crypto.randomUUID(),title:p.title,sourceId:'syllabus-course:'+p.sourceId,source:capture.source,slots:p.slots,room:p.room,campus:p.campus,instructor:p.instructor,term:p.term,notes:'',updatedAt:capture.capturedAt};next.courses.push(course);}
    if(course)Object.assign(course,{room:p.room||course.room,campus:p.campus||course.campus,instructor:p.instructor||course.instructor,term:p.term||course.term,updatedAt:capture.capturedAt});
    const existing=next.pages.find(x=>x.sourceId===p.sourceId);
    if(existing)Object.assign(existing,p,{courseId:course?.id||null,capturedAt:capture.capturedAt,source:capture.source});
    else next.pages.push({...p,id:crypto.randomUUID(),courseId:course?.id||null,capturedAt:capture.capturedAt,source:capture.source});
  }
  next.updatedAt=now;return next;
}
export function validateBackup(raw){
  if(raw?.kind!=='chuo-pocket-backup'||![1,STATE_SCHEMA].includes(raw.data?.schemaVersion))throw new Error('対応する中大ポケットのバックアップを選んでください。');
  const s=raw.data;if(!Array.isArray(s.courses)||!Array.isArray(s.tasks)||!Array.isArray(s.pages))throw new Error('バックアップの保存データが不足しています。');
  if(s.courses.length>1000||s.tasks.length>5000||s.pages.length>1000)throw new Error('バックアップの項目数が多すぎます。');
  const next=emptyState();const ids=new Set();
  for(const c of array(s.courses,1000)){const id=text(c.id,150);if(!id||ids.has(id)||!text(c.title))throw new Error('授業データの形式が正しくありません。');ids.add(id);next.courses.push({id,title:text(c.title),sourceId:text(c.sourceId,150),source:text(c.source,30),slots:slots(c.slots),room:text(c.room),campus:text(c.campus),instructor:text(c.instructor),term:text(c.term,120),notes:text(c.notes,5000),url:safeURL(c.url),updatedAt:date(c.updatedAt)});}
  const taskIDs=new Set();for(const t of array(s.tasks)){const id=text(t.id,150);if(!id||taskIDs.has(id)||!text(t.title))throw new Error('課題データの形式が正しくありません。');taskIDs.add(id);next.tasks.push({id,title:text(t.title),sourceId:text(t.sourceId,150),source:text(t.source,30),courseId:ids.has(t.courseId)?t.courseId:null,courseTitle:text(t.courseTitle),sourceCourseId:text(t.sourceCourseId,150),dueAt:date(t.dueAt),isCompleted:t.isCompleted===true,notes:text(t.notes,5000),url:safeURL(t.url),updatedAt:date(t.updatedAt)});}
  const pageIDs=new Set();for(const p of array(s.pages,1000)){const id=text(p.id,150);if(!id||pageIDs.has(id)||!text(p.title))throw new Error('シラバスデータの形式が正しくありません。');pageIDs.add(id);next.pages.push({id,title:text(p.title),sourceId:text(p.sourceId,150),source:text(p.source,30),courseId:ids.has(p.courseId)?p.courseId:null,bodyText:text(p.bodyText,100000),url:safeURL(p.url),room:text(p.room),campus:text(p.campus),instructor:text(p.instructor),courseCode:text(p.courseCode,80),year:text(p.year,20),term:text(p.term,120),slots:slots(p.slots),capturedAt:date(p.capturedAt)});}
  next.updatedAt=date(s.updatedAt);next.revision=Number.isSafeInteger(s.revision)&&s.revision>=0?s.revision:0;next.preferences.lastBackupAt=date(s.preferences?.lastBackupAt);return next;
}
export function tokyoToday(){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const get=k=>parts.find(p=>p.type===k).value;return`${get('year')}-${get('month')}-${get('day')}`;}
export function dayNumber(iso){return(new Date(iso+'T12:00:00+09:00').getUTCDay()+6)%7+1;}
export function shiftDate(iso,offset){const d=new Date(iso+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+offset);return d.toISOString().slice(0,10);}
export function displayDate(iso,full=false){return new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',...(full?{hour:'2-digit',minute:'2-digit'}:{weekday:'short'})}).format(new Date(iso.length===10?iso+'T12:00:00+09:00':iso));}
export function deadlineInput(iso){if(!iso)return '';const d=new Date(new Date(iso).getTime()+9*3600000);return d.toISOString().slice(0,16);}
export function deadlineISO(value){if(!value)return null;const d=new Date(value+':00+09:00');if(!Number.isFinite(d.getTime()))throw new Error('締切の日時を確認してください。');return d.toISOString();}
class StorageError extends Error{constructor(message,code='storage'){super(message);this.name='StorageError';this.code=code;}}
function storageError(error){
  if(error instanceof StorageError)return error;
  if(error?.name==='QuotaExceededError')return new StorageError('空き容量が足りず保存できませんでした。入力内容は画面に残しています。容量を空けて再試行してください。','quota');
  return new StorageError('端末の保存を完了できませんでした。最後に保存できたデータは保持しています。入力内容を残したまま再試行してください。');
}
export function migrateSnapshot(raw){
  if(raw===undefined||raw===null)return emptyState();
  if(![1,STATE_SCHEMA].includes(raw.schemaVersion))throw new StorageError('このアプリでは保存データのバージョンを開けません。元のデータを保護するため上書きを停止しています。','schema');
  try{validateBackup({kind:'chuo-pocket-backup',data:raw});}catch{throw new StorageError('保存データの形式を確認できません。元のデータを保護するため上書きを停止しています。バックアップから復元できます。','corrupt');}
  const dates=[raw.updatedAt,...raw.courses.map(c=>c.updatedAt),...raw.tasks.flatMap(t=>[t.updatedAt,t.dueAt]),...raw.pages.map(p=>p.capturedAt)];
  if(dates.some(value=>value!==undefined&&value!==null&&value!==''&&!date(value))||raw.courses.some(c=>!Array.isArray(c.slots)||c.slots.some(s=>!s||!Number.isInteger(s.day)||s.day<1||s.day>7||!Number.isInteger(s.period)||s.period<1||s.period>9)))throw new StorageError('保存データの日時・時間割を確認できません。元のデータは上書きしていません。','corrupt');
  if(raw.schemaVersion===STATE_SCHEMA&&(!Number.isSafeInteger(raw.revision)||raw.revision<0||!raw.preferences||typeof raw.preferences!=='object'||Array.isArray(raw.preferences)))throw new StorageError('保存データの管理情報を確認できません。元のデータは上書きしていません。','corrupt');
  const next=structuredClone(raw);next.schemaVersion=STATE_SCHEMA;next.revision=raw.schemaVersion===1?0:raw.revision;next.preferences={...next.preferences,lastBackupAt:date(next.preferences?.lastBackupAt)};return next;
}
export class LocalStore{
  constructor({indexedDB=globalThis.indexedDB,storage=globalThis.navigator?.storage,broadcast=true}={}){
    this.indexedDB=indexedDB;this.storage=storage;this.db=null;this.state=emptyState();this.hasLoaded=false;this.readOnly=false;this.isSaving=false;this._tail=Promise.resolve();this._opening=null;
    this.status={phase:'loading',message:'保存データを開いています',lastSavedAt:null};this.storageInfo={supported:!!storage?.persist,persistent:null,usage:null,quota:null};
    this.channel=broadcast&&typeof BroadcastChannel==='function'?new BroadcastChannel('chuo-pocket-local'):null;
    this.channel?.addEventListener('message',()=>{this.reload().catch(()=>{});});
  }
  _status(phase,message){this.status={phase,message,lastSavedAt:this.hasLoaded?this.state.updatedAt:null};this.onstatus?.(this.status);}
  _enqueue(work){const result=this._tail.then(work);this._tail=result.catch(()=>{});return result;}
  _transaction(mode){
    if(!this.db)throw new StorageError('保存領域を開けていません。「保存を再確認」からやり直してください。');
    if(mode==='readwrite'){try{return this.db.transaction('data',mode,{durability:'strict'});}catch(error){if(!['TypeError','NotSupportedError'].includes(error?.name))throw error;}}
    return this.db.transaction('data',mode);
  }
  async open(){
    if(this._opening)return this._opening;
    this._opening=(async()=>{
      this._status('loading','保存データを開いています');
      try{
        if(!this.indexedDB)throw new StorageError('このブラウザーでは端末保存を利用できません。Safariの通常タブで開いてください。');
        if(!this.db)this.db=await new Promise((resolve,reject)=>{
          let settled=false;const r=this.indexedDB.open('chuo-pocket-v1',1);
          r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains('data'))r.result.createObjectStore('data');};
          r.onblocked=()=>{settled=true;reject(new StorageError('別のタブが保存領域を使っています。このサイトの他のタブを閉じて、保存を再確認してください。','blocked'));};
          r.onerror=()=>{settled=true;reject(storageError(r.error));};
          r.onsuccess=()=>{if(settled){r.result.close();return;}resolve(r.result);};
        });
        this.db.onversionchange=()=>{this.db?.close();this.db=null;this.readOnly=true;this._status('error','別のタブで保存領域が更新されました。この画面の内容は保持しています。保存を再確認してください。');};
        this.db.onclose=()=>{this.db=null;this.readOnly=true;this._status('error','端末の保存領域との接続が閉じました。保存を再確認してください。');};
        await this.reload();await this.refreshStorageInfo();return this.state;
      }catch(error){this.readOnly=true;const failure=storageError(error);this._status('error',failure.message);throw failure;}
    })();
    try{return await this._opening;}finally{this._opening=null;}
  }
  async reload(){
    return this._enqueue(async()=>{
      try{
        const loaded=await new Promise((resolve,reject)=>{
          const tx=this._transaction('readwrite');const object=tx.objectStore('data');let next,failure;const r=object.get('snapshot');
          r.onsuccess=()=>{try{
            if(r.result===undefined&&this.hasLoaded&&(this.state.updatedAt||this.state.courses.length||this.state.tasks.length||this.state.pages.length))throw new StorageError('保存領域からデータが見つかりません。画面のデータは保持し、上書きを停止しています。バックアップを保存してから復元してください。','missing');
            next=migrateSnapshot(r.result);
            if(r.result?.schemaVersion===1){object.put(r.result,'previous-snapshot');object.put(next,'snapshot');}
          }catch(error){failure=error;tx.abort();}};
          tx.oncomplete=()=>resolve(next);tx.onerror=()=>{failure=failure||tx.error;};tx.onabort=()=>reject(storageError(failure||tx.error));
        });
        const changed=!this.hasLoaded||loaded.revision!==this.state.revision||loaded.updatedAt!==this.state.updatedAt;
        this.state=loaded;this.hasLoaded=true;this.readOnly=false;this._status('saved',loaded.updatedAt?'この端末に保存済み':'保存の準備ができました');if(changed)this.onchange?.(loaded);return loaded;
      }catch(error){this.readOnly=true;const failure=storageError(error);this._status('error',failure.message);throw failure;}
    });
  }
  async change(fn,{forgetPrevious=false,allowRecovery=false,recordPrevious=true}={}){
    return this._enqueue(async()=>{
      if(this.readOnly&&!allowRecovery)throw new StorageError('元の保存データを保護するため変更を停止しています。保存を再確認するか、バックアップから復元してください。');
      this.isSaving=true;this._status('saving','この端末に保存中…閉じずにお待ちください');
      try{
        const updated=await new Promise((resolve,reject)=>{
          const tx=this._transaction('readwrite');const object=tx.objectStore('data');let next,failure;const r=object.get('snapshot');
          r.onsuccess=()=>{try{
            let old,needsRecovery=false;try{old=migrateSnapshot(r.result);}catch(error){if(!allowRecovery)throw error;old=emptyState();needsRecovery=true;}
            next=fn(structuredClone(old));next.schemaVersion=STATE_SCHEMA;next.revision=old.revision+1;next.updatedAt=new Date().toISOString();next.preferences={...next.preferences,lastBackupAt:date(next.preferences?.lastBackupAt)};next=migrateSnapshot(next);
            if(forgetPrevious){object.delete('previous-snapshot');object.delete('recovery-original');}
            else if(recordPrevious&&r.result!==undefined)object.put(r.result,needsRecovery?'recovery-original':'previous-snapshot');
            object.put(next,'snapshot');
          }catch(error){failure=error;tx.abort();}};
          tx.oncomplete=()=>resolve(next);tx.onerror=()=>{failure=failure||tx.error;};tx.onabort=()=>reject(storageError(failure||tx.error));
        });
        this.state=updated;this.hasLoaded=true;this.readOnly=false;this._status('saved','この端末に保存済み');this.onchange?.(updated);this.channel?.postMessage('changed');return updated;
      }catch(error){const failure=storageError(error);if(['schema','corrupt','missing'].includes(failure.code))this.readOnly=true;this._status('error',failure.message);throw failure;}
      finally{this.isSaving=false;}
    });
  }
  async previousSnapshot(){
    await this._tail;return new Promise((resolve,reject)=>{const tx=this._transaction('readonly');let previous;const r=tx.objectStore('data').get('previous-snapshot');r.onsuccess=()=>{previous=r.result;};tx.oncomplete=()=>{try{resolve(previous===undefined?null:migrateSnapshot(previous));}catch(error){reject(storageError(error));}};tx.onabort=()=>reject(storageError(tx.error));});
  }
  async restoreBackup(snapshot){const validated=validateBackup({kind:'chuo-pocket-backup',data:snapshot});return this.change(()=>validated,{allowRecovery:true});}
  async refreshStorageInfo(){
    const info={supported:typeof this.storage?.persist==='function',persistent:null,usage:null,quota:null};
    try{if(typeof this.storage?.persisted==='function')info.persistent=await this.storage.persisted();if(typeof this.storage?.estimate==='function'){const estimate=await this.storage.estimate();info.usage=Number.isFinite(estimate.usage)?estimate.usage:null;info.quota=Number.isFinite(estimate.quota)?estimate.quota:null;}}catch{}
    this.storageInfo=info;this.onstorageinfo?.(info);return info;
  }
  async requestPersistence(){
    if(typeof this.storage?.persist!=='function'){await this.refreshStorageInfo();return null;}
    let granted;try{granted=await this.storage.persist();}catch{await this.refreshStorageInfo();throw new StorageError('保存の保護を要求できませんでした。通常の端末保存は続けられます。');}await this.refreshStorageInfo();this.storageInfo.persistent=granted===true;this.onstorageinfo?.(this.storageInfo);return granted===true;
  }
  close(){this.channel?.close();this.db?.close();this.db=null;}
}
