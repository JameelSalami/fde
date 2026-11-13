/* FDE W1 — personal workspace and authenticated shared review.
   The host owns authentication, persistence, compiled admission and model calls.
   The browser cannot interpret source truth or grant vendor effects.
   Source data is always inserted as text, never as executable HTML. */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const tabs=["case","evidence","why","workspace","handoff","boundary"];
  const panelDefinitions=[
    {id:"interpretation",title:"Compiled diagnostic",navigate:"why",subtitle:"What Haskell concluded from the supplied reports"},
    {id:"sources",title:"Native source context",navigate:"evidence",subtitle:"Two systems, two independent reads"},
    {id:"lineage",title:"Evidence behind the claim",navigate:"why",subtitle:"Source IDs, query receipts and selected inputs"},
    {id:"notes",title:"My working note",navigate:"workspace",subtitle:"Private browser-local context, not an ERP field"},
    {id:"deliverable",title:"Take it to the team",navigate:"handoff",subtitle:"Excel-compatible CSV and source evidence JSON"}
  ];
  const known=new Set(panelDefinitions.map(x=>x.id));
  const storageKey="fde.w1.local-surface.v1";
  const defaults=()=>({order:panelDefinitions.map(x=>x.id),hidden:[],
    question:"",note:""});
  function restore(){
    try{
      const value=JSON.parse(localStorage.getItem(storageKey)||"null");
      if(!value||typeof value!=="object")return defaults();
      const ids=Array.isArray(value.order)?value.order.filter(x=>typeof x==="string"&&known.has(x)):[];
      const order=[...new Set(ids.concat(panelDefinitions.map(x=>x.id)))];
      const hidden=Array.isArray(value.hidden)?[...new Set(value.hidden.filter(x=>known.has(x)))]:[];
      return {order,hidden,
        question:typeof value.question==="string"?value.question.slice(0,280):"",
        note:typeof value.note==="string"?value.note.slice(0,5000):""};
    }catch{return defaults();}
  }
  const state={caseView:null,settings:restore(),section:"case",refreshing:false};
  const strings={unavailable:"Source observation unavailable",loading:"Loading source observation"};
  function save(){
    try{localStorage.setItem(storageKey,JSON.stringify(state.settings));}
    catch{toast("Browser storage is unavailable; notes will last only until refresh.",true);}
  }
  function element(tag,classes,text){
    const node=document.createElement(tag);
    if(classes)node.className=classes;
    if(text!==undefined&&text!==null)node.textContent=String(text);
    return node;
  }
  function add(parent,...children){
    for(const child of children){if(child!==null&&child!==undefined)parent.appendChild(child);}
    return parent;
  }
  function text(id,value){const node=$(id);if(node)node.textContent=String(value??"—");}
  function button(label,action,classes=""){
    const b=element("button",classes,label);b.type="button";b.addEventListener("click",action);return b;
  }
  function toast(message,error=false){
    const node=$("toast");node.textContent=message;
    node.classList.toggle("error",error);
    node.classList.remove("hidden");
    clearTimeout(toast.active);
    toast.active=setTimeout(()=>node.classList.add("hidden"),4800);
  }
  function navigate(section,moveFocus=true){
    if(!tabs.includes(section))return;
    state.section=section;
    for(const name of tabs)$("view-"+name).classList.toggle("hidden",name!==section);
    for(const b of document.querySelectorAll("[data-section]")){
      const selected=b.dataset.section===section;
      b.classList.toggle("active",selected);
      if(selected)b.setAttribute("aria-current","page");
      else b.removeAttribute("aria-current");
    }
    window.scrollTo({top:0,behavior:"auto"});
    if(moveFocus){
      const heading=$(section+"-heading");
      if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true});}
    }
  }
  for(const link of document.querySelectorAll("[data-section]"))
    link.addEventListener("click",()=>navigate(link.dataset.section));
  for(const link of document.querySelectorAll("[data-goto]"))
    link.addEventListener("click",()=>navigate(link.dataset.goto));
  function status(mode,message){
    $("connection-pill").classList.remove("live","error");
    if(mode)$("connection-pill").classList.add(mode);
    text("connection-label",message);
  }
  function prettyTime(raw){
    if(!raw)return "not observed";
    const d=new Date(raw);
    return Number.isFinite(d.getTime())?
      d.toLocaleString(undefined,{dateStyle:"medium",timeStyle:"short"}):String(raw);
  }
  function fieldList(target,rows){
    const container=$(target);container.replaceChildren();
    for(const [label,value] of rows){
      add(container,element("dt","",label),element("dd","",value??"Not observed"));
    }
  }
  function sourceDetails(source){
    return [
      ["System",source.vendor],["Source instance",source.instance],
      ["Native record ID",source.nativeId],["Business label",source.businessId],
      ["Native revision",source.revision],["Reported native state",source.nativeState],
      ["Planned quantity",source.planned+" "+source.unit],
      ["Reported / recorded quantity",source.reported+" "+source.unit],
      ["Captured at",source.capture.observedAt],
      ["Query SHA-256",source.capture.querySha256],
      ["Host transport",source.capture.transport],
      ["Acquisition mode",source.capture.mode],
      ["Native order row",source.coverage.order],
      ["Receipt coverage",source.coverage.receipt],
      ["Ledger coverage",source.coverage.ledger],
      ["Physical coverage",source.coverage.physical],
    ];
  }
  function renderEvidence(c){
    fieldList("erp-details",sourceDetails(c.sources.erp));
    fieldList("mes-details",sourceDetails(c.sources.mes));
    fieldList("binding-details",[
      ["Binding grade",c.binding.grade],["Comparison unit rule",c.binding.unit],
      ["ERP bound identity",c.binding.erp.instance+" / "+c.binding.erp.nativeId],
      ["MES bound identity",c.binding.mes.instance+" / "+c.binding.mes.nativeId],
      ["Business truth selected",String(c.diagnostic.businessTruthSelected)],
      ["External action authorized",String(c.observationScope.sourceWriteAllowed)]
    ]);
    fieldList("host-read-receipts",[
      ["Source class",c.dataClass],
      ["ERP observed",c.sources.erp.capture.observedAt],
      ["MES observed",c.sources.mes.capture.observedAt],
      ["ERP query SHA-256",c.sources.erp.capture.querySha256],
      ["MES query SHA-256",c.sources.mes.capture.querySha256],
      ["ERP transport",c.sources.erp.capture.transport],
      ["MES transport",c.sources.mes.capture.transport],
      ["Joint atomic snapshot",String(c.observationScope.distributedAtomicSnapshot)],
      ["Business truth admitted",String(c.observationScope.businessTruthAdmitted)],
      ["Vendor write allowed",String(c.observationScope.sourceWriteAllowed)]
    ]);
  }
  function renderWhy(c){
    text("why-classification",c.diagnostic.classification);
    const target=$("why-list");target.replaceChildren();
    for(const witness of c.why){
      const card=element("article","why-card");
      add(card,element("p","overline",witness.id==="quantity"?
        "SOURCE-REPORT COMPARISON":"PLAN COMPARISON"),
        element("h2","",witness.claim),
        element("div","why-value",witness.compilerValue));
      const list=element("ul","trace-list");
      add(list,
        element("li","","Compiler interpretation: "+witness.interpretation),
        element("li","","Candidate indices: "+witness.inputCandidates.join(" + ")),
        element("li","","Native IDs: "+witness.sourceNativeIds.join(" / ")),
        element("li","","Revisions: "+witness.sourceRevisions.join(" / ")),
        element("li","","ERP query: "+witness.sourceQueries[0]),
        element("li","","MES query: "+witness.sourceQueries[1])
      );
      add(card,list);
      const foot=element("p","field-hint","The difference is compiled from two source reports. No causal event or receipt posting is inferred.");
      add(card,foot);add(target,card);
    }
    const unknown=$("unknown-list");unknown.replaceChildren();
    for(const limitation of c.limitations)add(unknown,element("li","",limitation));
  }
  function panelContent(id,c){
    const wrap=element("div","panel-content");
    if(id==="interpretation"){
      add(wrap,element("div","panel-big",c?c.diagnostic.classification:"No current observation"));
      add(wrap,element("p","",c?
        "Haskell reported a difference of "+c.diagnostic.reportedDelta+
        " under the synthetic mapping. This is not a stock/physical completion fact.":
        "The host has not returned a verified source-bound diagnostic."));
    }else if(id==="sources"){
      add(wrap,element("p","",c?
        "ERPNext "+c.sources.erp.nativeId+" — "+c.sources.erp.nativeState:
        "ERPNext — awaiting read"));
      add(wrap,element("p","",c?
        "OpenMES "+c.sources.mes.nativeId+" — "+c.sources.mes.nativeState:
        "OpenMES — awaiting read"));
      add(wrap,element("p","",c?
        "Captured independently at "+prettyTime(c.sources.erp.capture.observedAt)+
        " and "+prettyTime(c.sources.mes.capture.observedAt):
        "No joint snapshot or currentness claim."));
    }else if(id==="lineage"){
      add(wrap,element("p","",c?
        "Native revisions: "+c.sources.erp.revision+" / "+c.sources.mes.revision:
        "Native revisions not yet observed."));
      add(wrap,element("p","",
        "Every claim is linked to source identities, query receipts and the compiled diagnostic—not a generated explanation."));
    }else if(id==="notes"){
      const val=state.settings.note.trim();
      add(wrap,element("p","",val?val.slice(0,220)+(val.length>220?"…":""):
        "Add an investigation note or a human question. It stays in this browser."));
      add(wrap,element("p","field-hint","Note: not shared with ERP, MES or the server."));
    }else if(id==="deliverable"){
      add(wrap,element("p","",
        "Export the precise observation already on screen into a four-row CSV for Excel or a lossless JSON evidence receipt."));
      add(wrap,element("p","field-hint",c?
        "Pinned: "+c.observationId.slice(0,29)+"…":
        "Unavailable until a source observation succeeds."));
    }
    return wrap;
  }
  function movePanel(id,delta){
    const list=state.settings.order;
    const i=list.indexOf(id),j=i+delta;
    if(i<0||j<0||j>=list.length)return;
    [list[i],list[j]]=[list[j],list[i]];
    save();renderPanels();renderPreferences();
  }
  function setVisibility(id,visible){
    state.settings.hidden=visible?state.settings.hidden.filter(x=>x!==id):
      [...new Set([...state.settings.hidden,id])];
    save();renderPanels();renderPreferences();
  }
  function renderPanels(){
    const container=$("panel-grid");container.replaceChildren();
    const shown=state.settings.order.filter(id=>!state.settings.hidden.includes(id));
    if(shown.length===0){
      add(container,element("div","white-card",
        "Every panel is hidden. Use My workspace → Restore all to see them again."));
      return;
    }
    for(const id of shown){
      const config=panelDefinitions.find(p=>p.id===id);
      if(!config)continue;
      const card=element("article","workspace-panel");
      const head=element("div","panel-head");
      const name=element("div","");
      add(name,element("span","panel-index","PANEL / "+String(state.settings.order.indexOf(id)+1).padStart(2,"0")),
        element("h3","",config.title));
      const actions=element("div","panel-controls");
      add(actions,
        button("↑",()=>movePanel(id,-1),"panel-up"),
        button("↓",()=>movePanel(id,1),"panel-down"),
        button("×",()=>setVisibility(id,false),"panel-hide"));
      for(const child of actions.children){
        if(child.textContent==="↑")child.setAttribute("aria-label","Move "+config.title+" up");
        if(child.textContent==="↓")child.setAttribute("aria-label","Move "+config.title+" down");
        if(child.textContent==="×")child.setAttribute("aria-label","Hide "+config.title);
      }
      add(head,name,actions);
      const foot=element("div","panel-foot");
      add(foot,button("Open full view ↗",()=>navigate(config.navigate)),
        element("span","",config.navigate.toUpperCase()));
      add(card,head,panelContent(id,state.caseView),foot);
      add(container,card);
    }
  }
  function renderPreferences(){
    const target=$("panel-preferences");target.replaceChildren();
    state.settings.order.forEach((id,i)=>{
      const p=panelDefinitions.find(d=>d.id===id);if(!p)return;
      const row=element("div","preference"),summary=element("div","");
      add(summary,element("strong","",p.title),element("small","",p.subtitle));
      const actions=element("div","preference-actions");
      const up=button("↑",()=>movePanel(id,-1));
      const down=button("↓",()=>movePanel(id,1));
      const visible=!state.settings.hidden.includes(id);
      const visibility=button(visible?"Hide":"Show",()=>setVisibility(id,!visible));
      up.disabled=i===0;down.disabled=i===state.settings.order.length-1;
      up.setAttribute("aria-label","Move "+p.title+" up");
      down.setAttribute("aria-label","Move "+p.title+" down");
      visibility.setAttribute("aria-label",(visible?"Hide ":"Show ")+p.title);
      add(actions,up,down,visibility);add(row,summary,actions);add(target,row);
    });
  }
  function renderCase(c){
    text("source-class",c.dataClass==="handwritten-fixture"?"HANDWRITTEN FIXTURE":"SYNTHETIC VENDOR LAB");
    text("case-question",state.settings.question.trim()||c.question);
    text("erp-reported",c.sources.erp.reported);
    text("mes-reported",c.sources.mes.reported);
    text("compiled-delta",c.diagnostic.reportedDelta);
    text("compiled-classification",c.diagnostic.classification);
    text("observation-time","ERP "+prettyTime(c.sources.erp.capture.observedAt)+
      " · MES "+prettyTime(c.sources.mes.capture.observedAt));
    renderEvidence(c);renderWhy(c);
    fieldList("handoff-identity",[
      ["Observation ID",c.observationId],
      ["Case ID",c.caseId],
      ["ERP captured",c.sources.erp.capture.observedAt],
      ["MES captured",c.sources.mes.capture.observedAt],
      ["Diagnostic grade",c.dataClass],
      ["Haskell admission",c.diagnostic.admissionStatus],
      ["Write capability",String(c.observationScope.sourceWriteAllowed)]
    ]);
    $("export-csv").disabled=false;$("export-json").disabled=false;
    renderPanels();
  }
  async function load(){
    if(pendingReview){toast("Retry the uncertain save before refreshing this case.",true);return;}
    if(state.refreshing)return;
    state.refreshing=true;
    $("refresh-btn").disabled=true;
    status("",strings.loading);
    try{
      const response=await fetch("/api/case",{cache:"no-store",credentials:"same-origin"});
      if(!response.ok)throw Error("source-unavailable");
      const c=await response.json();
      // No client-side semantic decisions: the server has already closed this view.
      if(c.schema!=="fde.connected-case/v1"||c.authority!=="none"||
         c.observationScope.sourceWriteAllowed!==false)
        throw Error("unsafe-display-claim");
      state.caseView=c;renderCase(c);await loadReview();
      const fixture=c.dataClass==="handwritten-fixture";
      status("live",fixture?"Handwritten fixture · no vendor read":"Lab sources observed");
    }catch{
      status("error",state.caseView?
        "Read failed · previous observation shown":"Sources currently unavailable");
      toast("The host could not return a new verified source read. No data was fabricated.",true);
    }finally{
      state.refreshing=false;$("refresh-btn").disabled=false;
    }
  }
  async function downloadCase(type){
    if(!state.caseView){toast("No case observation is available to export.",true);return;}
    const id=encodeURIComponent(state.caseView.observationId);
    const url=type==="csv"?"/api/export.csv?observationId="+id:
      "/api/export.json?observationId="+id;
    try{
      const response=await fetch(url,{cache:"no-store",credentials:"same-origin"});
      if(!response.ok)throw Error("expired-or-absent-snapshot");
      const blob=await response.blob();
      saveBlob(blob,"fde-case-evidence."+(type==="csv"?"csv":"json"));
      toast("Exact displayed observation exported. No new vendor read occurred.");
    }catch{toast("Snapshot export was refused. Refresh the source evidence and retry.",true);}
  }
  function saveBlob(blob,filename){
    const url=URL.createObjectURL(blob);
    const link=document.createElement("a");
    link.download=filename;link.href=url;link.hidden=true;
    document.body.appendChild(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1500);
  }
  function exportNote(){
    const v=state.settings;
    const payload={
      schema:"fde.browser-local-note/v1",authority:"none",
      sourceWriteAllowed:false,
      linkedObservationId:state.caseView?.observationId??null,
      question:v.question,note:v.note,
      disclosure:"Browser-local operator text is not authenticated source or semantic truth."
    };
    saveBlob(new Blob([JSON.stringify(payload,null,2)+"\n"],{type:"application/json"}),
      "fde-my-local-handoff-note.json");
    toast("Your personal note was saved locally, not sent to the vendor or host.");
  }
  let session=null,review=null,pendingReview=null;
  async function api(path,options={}){
    const response=await fetch(path,{cache:"no-store",credentials:"same-origin",...options});
    if(!response.ok){const error=new Error("request-refused");error.status=response.status;throw error;}
    return response.json();
  }
  function showReview(value){
    review=value;
    const freshness={"latest-observed":"Latest captured evidence","same-source-case":"Earlier capture · same source records","superseded":"Newer source records exist","stale":"Evidence needs refresh"};
    text("review-currentness",(freshness[value.currentness]||"Currentness unavailable")+" · review version "+value.version+
      " · source observation is "+Math.round(value.observationAgeMs/1000)+" seconds old");
    $("review-assignee").value=value.assignee||"";
    $("review-disposition").value=value.disposition;
    const permitted=session&&session.principal.role!=="viewer"&&["latest-observed","same-source-case"].includes(value.currentness);
    for(const id of ["review-assignee","review-disposition","review-note","save-review"])$(id).disabled=!permitted;
    const history=$("review-history");history.replaceChildren();
    for(const item of value.audit){
      const li=element("li","",item.createdAt+" · "+item.actor+" · v"+item.version+" · "+item.request.disposition+": "+item.request.note);
      history.append(li);
    }
    if(!value.audit.length)history.append(element("li","","No review actions recorded."));
    if(value.auditTruncated)history.append(element("li","","Showing the latest 100 of "+value.auditTotal+" actions. The complete audit remains in the application store."));
  }
  function showFdeSteps(report){
    if(report?.schema!=="fde.step-readout/v1"||report.authority!=="none"||
       report.sourceWriteAllowed!==false||report.observationId!==state.caseView?.observationId)
      throw Error("unqualified-step-readout");
    text("fde-step-decision",report.decision+" · P "+report.ptq[0].evidence+
      " / T "+report.ptq[1].evidence+" / Q "+report.ptq[2].evidence);
    const list=$("fde-step-list");list.replaceChildren();
    for(const stage of report.steps){
      if(report.resolution!=="summary"&&stage.id!==report.resolution)continue;
      list.append(element("li","",stage.id+": "+stage.status+". "+stage.next));
    }
    if(report.expanded)for(const [name,value] of Object.entries(report.expanded)){
      const shown=typeof value==="object"?JSON.stringify(value):String(value);
      list.append(element("li","",name+": "+shown.slice(0,240)));
    }
  }
  for(const button of document.querySelectorAll("[data-fde-step]")){
    button.addEventListener("click",async()=>{
      if(!state.caseView)return;
      try{
        showFdeSteps(await api("/api/steps?observationId="+
          encodeURIComponent(state.caseView.observationId)+
          "&resolution="+encodeURIComponent(button.dataset.fdeStep)));
      }catch{toast("The selected evidence step is unavailable. No source effect occurred.",true);}
    });
  }
  async function loadReview(){
    if(!state.caseView)return;
    try{
      if(!session){
        session=await api("/api/session");
        text("review-session","Signed in as "+session.principal.id+" · "+session.principal.role);
        for(const name of session.assignees){const option=element("option","",name);option.value=name;$("review-assignee").append(option);}
        $("draft-investigation").disabled=!session.modelEnabled||session.principal.role==="viewer";
        if(!session.modelEnabled)text("draft-investigation","AI suggestion is not enabled");
      }
      $("durable-review").classList.remove("hidden");
      showReview(await api("/api/review?observationId="+encodeURIComponent(state.caseView.observationId)));
      showInvestigation(await api("/api/investigation?observationId="+encodeURIComponent(state.caseView.observationId)));
      try{
        showFdeSteps(await api("/api/steps?observationId="+
          encodeURIComponent(state.caseView.observationId)+"&resolution=summary"));
      }catch{text("fde-step-decision","Step evidence unavailable; saved review remains separate.");}
      const listing=await api("/api/cases");const list=$("observation-history");list.replaceChildren();
      for(const item of listing.observations.slice(0,12)){
        const li=element("li","");
        li.append(button(new Date(item.capturedAt).toLocaleString()+" · "+item.disposition+" · "+(item.sourceHeadStatus==="unresolved-tie"?"source order unresolved":item.latestCase?"latest case":"historical"),async()=>{
          if(pendingReview){toast("Retry the uncertain save before changing observations.",true);return;}
          try{const c=await api("/api/export.json?observationId="+encodeURIComponent(item.observationId));
            pendingReview=null;state.caseView=c;renderCase(c);await loadReview();status("","Pinned historical observation");
          }catch{toast("The stored observation could not be verified.",true);}
        },"small-link"));list.append(li);
      }
    }catch(error){
      if(error.status===404&&!session)return; // Local preview has no durable workflow.
      text("review-currentness","Saved review is unavailable. Please retry.");$("save-review").disabled=true;
    }
  }
  $("save-review").addEventListener("click",async()=>{
    if(!review||!state.caseView)return;
    if(!pendingReview)pendingReview={actionId:crypto.randomUUID(),observationId:state.caseView.observationId,
      expectedVersion:review.version,assignee:$("review-assignee").value||null,
      disposition:$("review-disposition").value,note:$("review-note").value};
    $("save-review").disabled=true;
    $("refresh-btn").disabled=true;
    for(const id of ["review-assignee","review-disposition","review-note"])$(id).disabled=true;
    try{
      const result=await api("/api/review",{method:"POST",headers:{"Content-Type":"application/json","X-FDE-Request":"w1"},body:JSON.stringify(pendingReview)});
      pendingReview=null;$("review-note").value="";showReview(result.review);
      $("refresh-btn").disabled=false;
      toast(result.duplicate?"The earlier review was already saved. No duplicate was added.":"Review saved with your identity and evidence pin.");
    }catch(error){
      if([400,403,409,415].includes(error.status)){pendingReview=null;$("refresh-btn").disabled=false;await loadReview();
        toast(error.status===409?"The case or review changed. Refresh the evidence and check the saved history before saving again.":"Review refused. Check your role, disposition and note.",true);
      }else{toast("Save result is uncertain. Click Save review to retry the same action safely.",true);$("save-review").disabled=false;}
    }
  });
  $("replay-review").addEventListener("click",async()=>{
    if(!state.caseView)return;
    try{await api("/api/replay?observationId="+encodeURIComponent(state.caseView.observationId));toast("Pinned evidence replay matched. No fresh source read was used.");}
    catch{toast("Pinned replay was refused. The observation must be investigated.",true);}
  });
  $("export-handoff").addEventListener("click",async()=>{
    if(!state.caseView)return;
    try{const result=await api("/api/handoff.json?observationId="+encodeURIComponent(state.caseView.observationId));
      saveBlob(new Blob([JSON.stringify(result,null,2)+"\n"],{type:"application/json"}),"fde-review-handoff.json");
      toast("Evidence, admission and human review exported together.");
    }catch{toast("The review handoff could not be verified.",true);}
  });
  function showInvestigation(draft){
    if(draft.observationId!==state.caseView?.observationId)throw Error("draft-not-displayed-case");
    if(draft.schema!=="fde.investigation-draft/v1"||draft.authority!=="none"||draft.sourceWriteAllowed!==false||draft.humanReviewRequired!==true)throw Error("unsafe-draft");
    text("investigation-mode",(draft.mode==="model-selected"?"AI-assisted draft":"Evidence guide")+(draft.abstain?" · Interpretation withheld":"")+" · human review required");
    const cards=$("investigation-cards"),questions=$("investigation-questions");cards.replaceChildren();questions.replaceChildren();
    for(const card of draft.cards)cards.append(element("li","",card.text));
    for(const question of draft.questions)questions.append(element("li","",question.text));
    const sourceLink=element("li","");sourceLink.append(button("Inspect the pinned source evidence",()=>navigate("evidence"),"small-link"));cards.append(sourceLink);
  }
  // A model request is locally durable. Recheck an uncertain outcome; never POST it twice.
  const investigationKey=id=>"fde.w1.investigation."+id;
  const rememberInvestigation=(id,requestId)=>{
    try{if(requestId)sessionStorage.setItem(investigationKey(id),requestId);
      else sessionStorage.removeItem(investigationKey(id));}catch{}
  };
  const rememberedInvestigation=id=>{try{return sessionStorage.getItem(investigationKey(id));}catch{return null;}};
  $("draft-investigation").addEventListener("click",async()=>{
    if(!state.caseView||!session?.modelEnabled||session.principal.role==="viewer")return;
    const id=state.caseView.observationId;
    let requestId=rememberedInvestigation(id);
    $("draft-investigation").disabled=true;
    text("investigation-mode",requestId?
      "Checking an unconfirmed request; it will not run the model twice…":
      "Preparing a suggestion from pinned evidence…");
    try{
      let result;
      if(requestId)result=await api("/api/investigation-status?requestId="+encodeURIComponent(requestId));
      else{
        requestId=crypto.randomUUID();rememberInvestigation(id,requestId);
        result=await api("/api/investigation",{method:"POST",
          headers:{"Content-Type":"application/json","X-FDE-Request":"w1"},
          body:JSON.stringify({observationId:id,requestId})});
      }
      if(result.state==="pending"){
        text("investigation-mode","Request recorded. Its result is unknown or pending; use Check status, not Retry.");
        $("draft-investigation").textContent="Check investigation status";
      }else if(result.state==="completed"&&result.draft){
        showInvestigation(result.draft);rememberInvestigation(id,null);
        $("draft-investigation").textContent="Prepare a new suggestion";
      }else if(result.state==="failed"){
        rememberInvestigation(id,null);
        text("investigation-mode","The recorded attempt failed. The fixed evidence guide remains available.");
        $("draft-investigation").textContent="Start a new suggestion";
      }else throw Error("unqualified investigation state");
    }catch(error){
      text("investigation-mode","Outcome not confirmed. Check the saved request status before another attempt.");
      $("draft-investigation").textContent="Check investigation status";
      toast("The model request result is unknown; no automatic retry will run.",true);
    }finally{$("draft-investigation").disabled=session.principal.role==="viewer";}
  });
  $("refresh-btn").addEventListener("click",load);
  $("export-csv").addEventListener("click",()=>downloadCase("csv"));
  $("export-json").addEventListener("click",()=>downloadCase("json"));
  $("export-note").addEventListener("click",exportNote);
  $("restore-panels").addEventListener("click",()=>{
    state.settings.hidden=[];
    state.settings.order=panelDefinitions.map(x=>x.id);
    save();renderPanels();renderPreferences();
  });
  $("question-input").value=state.settings.question;
  $("working-note").value=state.settings.note;
  $("question-input").addEventListener("input",e=>{
    state.settings.question=e.target.value.slice(0,280);save();
    text("case-question",state.settings.question.trim()||
      state.caseView?.question||"What do ERPNext and OpenMES report about this order?");
  });
  $("working-note").addEventListener("input",e=>{
    state.settings.note=e.target.value.slice(0,5000);save();
    text("saved-indicator","Saved in this browser only");
    renderPanels();
  });
  renderPanels();renderPreferences();navigate("case",false);void load();
})();
