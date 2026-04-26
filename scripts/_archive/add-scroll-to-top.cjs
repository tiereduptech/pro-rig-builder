// add-scroll-to-top.cjs
const fs = require('fs');
const PATH = 'src/App.jsx';
let s = fs.readFileSync(PATH, 'utf8');

// 1) Inject the ScrollToTop component definition.
// Anchor: place it right before `export default function App()` so it's available globally.
const anchorComp = 'export default function App(){';
if (!s.includes(anchorComp)) { console.log('FATAL: App() anchor not found'); process.exit(1); }

const compCode = `function ScrollToTop(){
  const [show,setShow]=useState(false);
  useEffect(()=>{
    const onScroll=()=>setShow(window.scrollY>400);
    window.addEventListener("scroll",onScroll);
    onScroll();
    return ()=>window.removeEventListener("scroll",onScroll);
  },[]);
  if(!show)return null;
  return <button onClick={()=>window.scrollTo({top:0,behavior:"smooth"})}
    aria-label="Scroll to top"
    style={{position:"fixed",bottom:24,right:24,zIndex:9999,width:48,height:48,borderRadius:"50%",border:"1px solid var(--bdr)",background:"var(--accent)",color:"#fff",cursor:"pointer",fontSize:20,fontWeight:700,boxShadow:"0 4px 12px rgba(0,0,0,0.25)",display:"flex",alignItems:"center",justifyContent:"center",transition:"transform .15s, background .15s"}}
    onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-2px)";}}
    onMouseLeave={e=>{e.currentTarget.style.transform="translateY(0)";}}>
    ↑
  </button>;
}

`;

s = s.replace(anchorComp, compCode + anchorComp);
console.log('✓ Added ScrollToTop component');

// 2) Inject <ScrollToTop /> right before the closing </div> of App's main return.
const anchorDiv = '<Footer go={setPage}/></div>;';
if (!s.includes(anchorDiv)) { console.log('FATAL: Footer/closing div anchor not found'); process.exit(1); }

const newDiv = '<Footer go={setPage}/><ScrollToTop /></div>;';
s = s.replace(anchorDiv, newDiv);
console.log('✓ Injected <ScrollToTop /> into App return');

fs.writeFileSync(PATH, s);
console.log('\nDone. Run npm run build');
