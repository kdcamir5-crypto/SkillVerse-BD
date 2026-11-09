// SkillVerse BD — counts active time in the app (tab visible) and syncs it to the signed-in user's Firestore profile.
import {initializeApp,getApps} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {getAuth,onAuthStateChanged} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {getFirestore,doc,setDoc,increment,serverTimestamp} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import {firebaseConfig} from './firebase-config.js';
const app=getApps()[0]||initializeApp(firebaseConfig),auth=getAuth(app),db=getFirestore(app),PK='skillverse_pending_ms';
let user=null;
const pend=()=>Number(localStorage.getItem(PK))||0,setP=v=>{try{localStorage.setItem(PK,String(v))}catch(e){}};
async function push(fields){if(!user)return false;try{await setDoc(doc(db,'users',user.uid),{...fields,updatedAt:serverTimestamp()},{merge:true});return true}catch(e){return false}}
async function flush(){const m=Math.floor(pend()/60000);if(!user||m<1)return;setP(pend()-m*60000);if(!(await push({appMinutes:increment(m)})))setP(pend()+m*60000)}
onAuthStateChanged(auth,u=>{user=u;flush()});
setInterval(()=>{if(document.visibilityState==='visible'){setP(pend()+10000);flush()}},10000);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')flush()});
// call after the AI solves a photo/typed question
window.svTrack={solved:()=>push({photoSolved:increment(1)})};
