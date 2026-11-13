/* FDE industrial workbench.
 * The browser edits application records and displays host/Haskell results.
 * All quantities remain strings. Source truth, permission, and meaning stay
 * with their owners. No content from a case is inserted as HTML.
 */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const tabs = ["engagement","investigation","evidence","engineering","improvement","workers","handoff"];
  const state = {session:null,catalog:[],industrySet:null,emptyDocument:null,cases:[],saved:null,draft:null,
    listOffset:0,listNextOffset:null,listTotal:0,listPrevious:[],listLoading:false,listRequest:0,
    dirty:false,busy:false,exportBusy:false,pending:null,tab:"engagement",history:[],historyHasMore:false,historyCursor:null,
    evaluations:[],evaluation:null,evaluationsTruncated:false,evaluationTotal:0,imports:[],importsTruncated:false,
    sourceImportsEnabled:false,privateNotesAllowed:false,privateNote:null,privateDraft:"",privateDirty:false,
    importSourceId:"w1-observations",importObservationId:""};
  let fieldSequence=0;
  const clone = value => JSON.parse(JSON.stringify(value));
  const canEdit = () => !!state.session && state.session.principal.role !== "viewer";
  const editable = () => canEdit() && !state.busy && !state.pending;
  const node = (tag,className,text) => {
    const result=document.createElement(tag);
    if(className)result.className=className;
    if(text!==undefined && text!==null)result.textContent=String(text);
    return result;
  };
  const append = (parent,...children) => {for(const child of children)if(child)parent.append(child);return parent;};
  function button(label,action,className="button button-outline",edit=false){
    const result=node("button",className,label);result.type="button";
    if(edit){result.dataset.wbEditable="true";result.disabled=!editable();}
    result.addEventListener("click",action);return result;
  }
  function notice(message,kind="success"){
    const target=$("wb-notice");target.textContent=message;target.dataset.kind=kind;target.hidden=false;
  }
  function clearNotice(){$("wb-notice").hidden=true;}
  const readable = value => String(value).replaceAll("-"," ").replaceAll("_"," ");
  function changed(){
    state.dirty=true;
    $("wb-case-heading").textContent=state.draft.title.trim()||"Untitled investigation";
    updateControls();
  }
  function field(label,value,set,options={}){
    const box=node("div","wb-field"+(options.full?" wb-full":"")),id="wb-field-"+(++fieldSequence);
    const caption=node("label","",label);caption.htmlFor=id;
    let control;
    if(options.choices){
      control=node("select");
      for(const choice of options.choices){
        const [v,t]=Array.isArray(choice)?choice:[choice,readable(choice)];
        const o=node("option","",t);o.value=v;control.append(o);
      }
      control.value=value===null?"":String(value);
    }else{
      control=node(options.lines?"textarea":"input");
      if(!options.lines){control.type=options.type||"text";control.autocomplete="off";}
      else control.rows=options.lines;
      control.maxLength=options.maxLength||2000;
      control.value=value??"";
      if(options.placeholder)control.placeholder=options.placeholder;
      if(options.decimal)control.inputMode="decimal";
      if(options.required)control.required=true;
      if(options.pattern&&!options.lines)control.pattern=options.pattern.replaceAll("-]","\\-]");
    }
    control.id=id;control.dataset.wbEditable="true";control.disabled=!editable();
    if(options.validate)control.setCustomValidity(options.validate(control.value));
    control.addEventListener(options.choices?"change":"input",()=>{
      const val=options.nullable&&control.value.trim()===""?null:control.value;
      if(options.validate)control.setCustomValidity(options.validate(control.value));
      set(val);if(options.contextOnly)updateControls();else changed();
    });
    append(box,caption,control);
    if(options.hint){
      const hint=node("p","field-hint",options.hint);hint.id=id+"-hint";
      control.setAttribute("aria-describedby",hint.id);box.append(hint);
    }
    return box;
  }
  const textField=(object,key,label,options={})=>field(label,object[key],v=>{object[key]=v;},options);
  const paragraphs=(object,key,label,hint)=>textField(object,key,label,{lines:3,full:true,hint});
  const linesField=(object,key,label,hint,options={})=>field(label,(object[key]||[]).join("\n"),v=>{
    object[key]=v.split("\n").map(x=>x.trim()).filter(Boolean);
  },{lines:3,full:true,hint:hint+" Up to "+(options.maxItems||128)+" entries.",maxLength:8000,
    validate:value=>{
      const entries=value.split("\n").map(x=>x.trim()).filter(Boolean);
      if(entries.length>(options.maxItems||128))return "Use no more than "+(options.maxItems||128)+" entries.";
      if(entries.some(v=>v.length>(options.maxItemLength||240)))return "An entry exceeds "+(options.maxItemLength||240)+" characters.";
      return "";
    },...options});
  const boolField=(object,key,label,hint)=>field(label,String(object[key]),v=>{object[key]=v==="true";},
    {choices:[["false","No"],["true","Yes"]],hint});
  const triBoolField=(object,key,label,hint)=>field(label,object[key]===null?"unknown":String(object[key]),v=>{
    object[key]=v==="unknown"?null:v==="true";
  },{choices:[["unknown","Unknown"],["false","No"],["true","Yes"]],hint});
  function card(title,copy){
    const c=node("article","wb-card");c.append(node("h2","",title));
    if(copy)c.append(node("p","",copy));return c;
  }
  const grid=(...fields)=>append(node("div","wb-grid"),...fields);
  function help(title,copy){
    const h=node("div","wb-help");if(title)h.append(node("strong","",title));
    h.append(node("p","",copy));return h;
  }
  function repeat(title,copy,items,create,render,rerender,maxItems=32){
    const c=card(title,copy);
    if(!items.length)c.append(node("p","wb-empty-list","No entries yet."));
    items.forEach((item,index)=>{
      const row=node("fieldset","wb-repeat-row");
      row.append(node("legend","",title+" "+(index+1)));
      row.append(render(item,index));
      row.append(append(node("div","wb-row-actions"),
        button("Remove entry",()=>{items.splice(index,1);changed();rerender();},"wb-remove",true)));
      c.append(row);
    });
    const add=button("Add entry",()=>{if(items.length>=maxItems)return;items.push(create());changed();rerender();},"button button-outline wb-add",true);
    if(items.length>=maxItems){add.disabled=true;add.dataset.wbCapacity="full";}
    c.append(add);c.append(node("p","wb-count",items.length+" / "+maxItems+" entries"));return c;
  }
  const id=prefix=>prefix+"-"+crypto.randomUUID();
  function panel(name,...contents){$("wb-panel-"+name).replaceChildren(...contents);}
  async function api(path,options={}){
    const response=await fetch(path,{cache:"no-store",credentials:"same-origin",...options});
    let payload;
    try{payload=await response.json();}catch{payload=null;}
    if(!response.ok){
      const error=new Error(payload?.code||"request-refused");error.status=response.status;throw error;
    }
    return payload;
  }
  function errorMessage(error){
    const code=error.message||"request-failed";
    if(error.status===401)return "Your application session is unavailable. Sign in again before saving.";
    if(error.status===403)return "The host refused this action for your role or current authorization. "+code;
    if(error.status===409&&code==="workbench-private-note-version-conflict")return "The restricted note changed elsewhere. Your note draft is retained. Load the saved note to inspect its current version before saving again.";
    if(error.status===409)return "This saved case or assessment changed elsewhere. Your draft is retained. Reload the saved case to inspect the current version before saving again. "+code;
    if(error.status===400||error.status===415||error.status===422)return "The host refused these inputs. Check the fields and evidence references. "+code;
    return "The request did not return a confirmed result. "+code;
  }
  function chooseTab(name,focus=false){
    if(!tabs.includes(name))return;
    state.tab=name;
    for(const item of tabs){
      const selected=item===name,t=$("wb-tab-"+item);
      t.setAttribute("aria-selected",String(selected));t.tabIndex=selected?0:-1;
      $("wb-panel-"+item).hidden=!selected;
    }
    if(focus)$("wb-tab-"+name).focus();
  }
  function updateControls(){
    const saved=!!state.saved,active=!!state.draft;
    $("wb-new").disabled=!canEdit()||state.busy||!!state.pending;
    $("wb-empty-new").disabled=$("wb-new").disabled;
    $("wb-save").disabled=!active||!canEdit()||state.busy||
      (!!state.pending&&state.pending.kind!=="save")||(!state.dirty&&!state.pending);
    $("wb-assess").disabled=!saved||!canEdit()||state.busy||state.dirty||
      (!!state.pending&&state.pending.kind!=="assess");
    $("wb-reload").disabled=!saved||state.busy||!!state.pending;
    $("wb-save").textContent=state.pending?.kind==="save"?"Retry pending save":"Save case";
    $("wb-assess").textContent=state.pending?.kind==="assess"?"Retry pending assessment":"Assess saved evidence";
    $("wb-save-status").textContent=state.pending?"Unconfirmed action — retry the same request":
      state.busy?"Waiting for the host…":state.dirty?"Unsaved changes":
      saved?"Saved version "+state.saved.version:"New draft — save to create a case";
    for(const control of document.querySelectorAll("[data-wb-editable]"))control.disabled=!editable()||control.dataset.wbCapacity==="full";
    const retry=$('wb-retry-extra');
    if(retry)retry.disabled=!canEdit()||state.busy||!!state.pending&&state.pending.kind!=="private";
    const importRetry=$('wb-retry-import');
    if(importRetry)importRetry.disabled=!canEdit()||state.busy||state.dirty||!!state.pending&&state.pending.kind!=="import";
    const privateStatus=$('wb-private-status');
    if(privateStatus&&state.privateNote)privateStatus.textContent="Restricted note version "+state.privateNote.version+(state.privateDirty?" · unsaved changes":"");
    $("wb-list-previous").disabled=state.listLoading||state.listPrevious.length===0;
    $("wb-list-next").disabled=state.listLoading||state.listNextOffset===null;
    const exportButton=$("wb-export");
    const industryButton=$("wb-industry-export");
    if(industryButton)industryButton.disabled=state.exportBusy||state.busy||!!state.pending;
    if(exportButton){exportButton.disabled=state.exportBusy||state.busy||!!state.pending;exportButton.textContent=state.exportBusy?"Preparing complete handoff…":"Download complete saved handoff";}
  }
  function renderCases(){
    const container=$("wb-case-list");container.replaceChildren();
    const filtered=state.cases;
    for(const c of filtered){
      const b=button("",()=>openCase(c.caseId),"wb-case-link");
      append(b,node("strong","",c.title||c.document?.title||"Untitled investigation"),
        node("small","",readable(c.kind||"investigation")+" · "+readable(c.phase||"define")+" · version "+c.version));
      if(c.caseId===state.saved?.caseId)b.setAttribute("aria-current","page");container.append(b);
    }
    $("wb-list-status").textContent=state.cases.length?"Showing "+(state.listOffset+1)+"–"+(state.listOffset+filtered.length)+" of "+state.listTotal+" matching cases":
      $("wb-search").value.trim()?"No matching cases.":"No saved cases yet.";
  }
  function acceptCase(value){
    const saved=value.case||value;
    if(!saved?.document||!saved.caseId||!Number.isInteger(saved.version))throw Error("invalid-case-response");
    const sameCase=state.saved?.caseId===saved.caseId;
    state.saved=saved;state.draft=clone(saved.document);state.dirty=false;
    state.cases=state.cases.map(item=>item.caseId===saved.caseId?{...item,title:saved.document.title,
      version:saved.version,kind:saved.document.investigation.kind,phase:saved.document.investigation.phase}:item);
    state.evaluations=value.evaluations||(sameCase?state.evaluations:[]);
    state.evaluation=value.evaluation||state.evaluations.at(-1)||null;
    state.evaluationsTruncated=value.evaluationsTruncated??(sameCase?state.evaluationsTruncated:false);
    state.evaluationTotal=value.evaluationTotal??state.evaluations.length;
    state.imports=value.imports||(sameCase?state.imports:[]);
    state.importsTruncated=value.importsTruncated??(sameCase?state.importsTruncated:false);
    if(!sameCase){state.history=[];state.historyHasMore=false;state.historyCursor=null;state.privateNote=null;state.privateDraft="";state.privateDirty=false;state.importSourceId="w1-observations";state.importObservationId="";}
    render();
  }
  function discardAllowed(){
    if(state.pending){notice("Retry the pending action before changing cases.","warning");return false;}
    return !(state.dirty||state.privateDirty)||window.confirm("Discard the unsaved changes in this case or restricted note?");
  }
  async function loadCases(offset=0,direction="reset"){
    const search=$("wb-search").value.trim();
    const request=++state.listRequest;state.listLoading=true;updateControls();
    try{
      const result=await api("/api/workbench/cases?offset="+offset+(search?"&q="+encodeURIComponent(search):""));
      if($("wb-search").value.trim()!==search||state.listRequest!==request)return;
      if(!Array.isArray(result.cases)||!Number.isSafeInteger(result.total)||result.total<0||
        (result.nextOffset!==null&&!Number.isSafeInteger(result.nextOffset)))throw Error("invalid-case-list-response");
      if(direction==="next")state.listPrevious.push(state.listOffset);
      else if(direction==="previous")state.listPrevious.pop();
      else state.listPrevious=[];
      state.listOffset=offset;state.listTotal=result.total;state.listNextOffset=result.hasMore?result.nextOffset:null;
      state.cases=result.cases;renderCases();
    }finally{if(state.listRequest===request){state.listLoading=false;updateControls();}}
  }
  async function openCase(caseId){
    if(state.busy)return;
    if(!discardAllowed())return;
    state.busy=true;updateControls();clearNotice();
    try{acceptCase(await api("/api/workbench/case?id="+encodeURIComponent(caseId)));
      state.privateNote=null;state.privateDraft="";state.privateDirty=false;renderWorkers();await loadHistory();}
    catch(error){notice(errorMessage(error),"error");}
    finally{state.busy=false;updateControls();}
  }
  function newCase(){
    if(!state.emptyDocument||!canEdit()||!discardAllowed())return;
    state.saved=null;state.draft=clone(state.emptyDocument);state.dirty=true;
    state.history=[];state.historyHasMore=false;state.historyCursor=null;state.evaluations=[];state.evaluation=null;state.imports=[];
    state.evaluationsTruncated=false;state.importsTruncated=false;state.privateNote=null;state.privateDraft="";state.privateDirty=false;state.tab="engagement";
    clearNotice();render();
  }
  async function mutate(kind){
    if(state.busy||!canEdit())return;
    if(!state.pending){
      if(kind==="save"){
        const invalid=[...document.querySelectorAll("[data-wb-editable]")].find(control=>!control.checkValidity());
        if(invalid){const containingPanel=invalid.closest(".wb-panel");if(containingPanel)chooseTab(containingPanel.id.replace("wb-panel-",""));invalid.reportValidity();return;}
      }
      if(kind==="assess"&&(!state.saved||state.dirty))return;
      state.pending=kind==="save"?{
        kind,path:state.saved?"/api/workbench/case":"/api/workbench/cases",
        payload:state.saved?{actionId:crypto.randomUUID(),caseId:state.saved.caseId,expectedVersion:state.saved.version,document:clone(state.draft)}:
          {actionId:crypto.randomUUID(),document:clone(state.draft)}
      }:{kind,path:"/api/workbench/evaluate",payload:{actionId:crypto.randomUUID(),caseId:state.saved.caseId,expectedVersion:state.saved.version}};
    }
    if(state.pending.kind!==kind)return;
    state.busy=true;updateControls();
    try{
      const request=state.pending;
      const result=await api(request.path,{method:"POST",headers:{"Content-Type":"application/json","X-FDE-Request":"workbench"},body:JSON.stringify(request.payload)});
      if(kind==="save"){
        acceptCase(result);state.pending=null;
        notice(result.duplicate?"The earlier save was already recorded.":"Case saved with your identity and version.");
        await loadCases().catch(error=>notice("Case saved, but the case list could not refresh. "+errorMessage(error),"warning"));
      }
      else{
        if(!result.evaluation?.evaluationId||result.evaluation.caseId!==state.saved.caseId)throw Error("invalid-evaluation-response");
        state.pending=null;state.evaluation=result.evaluation;
        state.evaluations=[...state.evaluations.filter(e=>e.evaluationId!==state.evaluation.evaluationId),state.evaluation];
        state.evaluationTotal=state.evaluations.length;renderEvidence();renderHandoff();notice("Assessment recorded against the saved inputs. Review its findings and limits.");chooseTab("evidence");}
      await loadHistory();
    }catch(error){
      if([400,401,403,404,409,413,415,422].includes(error.status))state.pending=null;
      notice(errorMessage(error)+(state.pending?" Retry the same action to resolve its status safely.":""),"error");
    }finally{state.busy=false;updateControls();}
  }
  function renderEngagement(){
    const d=state.draft,e=d.engagement;
    const overview=card("Engagement and decision","Record who owns the work, what is in scope, and the decision this investigation should support.");
    overview.append(grid(textField(d,"title","Case title",{full:true,maxLength:160,required:true}),
      textField(e,"organization","Organization"),textField(e,"sponsor","Sponsor"),
      textField(e,"processOwner","Process owner"),textField(e,"localObservationOwner","Local observation owner"),
      paragraphs(e,"scope","Process and system boundaries","Describe the work, location, and exclusions."),
      paragraphs(e,"decision","Decision to support"),
      paragraphs(e,"dataHandling","Data handling and export conditions","Record applicable restrictions. Do not enter passwords, access tokens, or private worker information.")));
    const systems=repeat("Systems","Identify relevant source owners and why each system matters.",e.systems,
      ()=>({id:id("system"),name:"",owner:"",purpose:""}),item=>grid(textField(item,"id","System reference",{maxLength:96,required:true,pattern:"[A-Za-z0-9][A-Za-z0-9._:-]*"}),
        textField(item,"name","System name"),textField(item,"owner","System owner"),
        paragraphs(item,"purpose","Purpose in this investigation")),renderEngagement);
    const groups=repeat("Affected groups","Use group names and shared concerns. Private individual information belongs outside the ordinary case record.",e.affectedGroups,
      ()=>({id:id("group"),name:"",concern:""}),item=>grid(textField(item,"id","Group reference",{maxLength:96,required:true,pattern:"[A-Za-z0-9][A-Za-z0-9._:-]*"}),
        textField(item,"name","Group name"),paragraphs(item,"concern","Worker concern")),renderEngagement);
    const permissions=repeat("Permission records","These records describe approval. Actual source access is independently enforced by the host.",e.permissionRecords,
      ()=>({sourceId:"",approver:"",reference:"",validUntil:"",notes:""}),item=>grid(
        textField(item,"sourceId","Approved source reference",{maxLength:96,required:true,pattern:"[A-Za-z0-9][A-Za-z0-9._:-]*"}),textField(item,"approver","Approver"),
        textField(item,"reference","Approval reference"),textField(item,"validUntil","Valid until",{hint:"Use an ISO date/time, including timezone."}),
        paragraphs(item,"notes","Scope, allowed actions, and restrictions")),renderEngagement);
    panel("engagement",overview,systems,groups,permissions);
  }
  function renderInvestigation(){
    const i=state.draft.investigation;
    const charter=card("DMAIC investigation","Choose the question and the evidence needed to answer it. Phase and hypothesis status record human review, not proof of cause.");
    const choices=state.catalog.map(c=>[c.id,c.title||c.name||readable(c.id)]);
    if(!choices.some(c=>c[0]===i.kind))choices.unshift([i.kind,readable(i.kind)]);
    charter.append(grid(textField(i,"kind","Investigation family",{choices}),
      textField(i,"phase","Reviewer-entered DMAIC phase",{choices:["define","measure","analyze","improve","control"]}),
      paragraphs(i,"problem","Problem and affected work"),paragraphs(i,"baseline","Baseline and comparison conditions"),
      paragraphs(i,"measurementPlan","Measurement plan","State what to observe, how, the sampling basis, and what would make the comparison invalid.")));
    const catalog=card("Investigation catalog","Select a bounded investigation using its inputs, prerequisites, and limits.");
    const list=node("div","wb-catalog-list");
    for(const entry of state.catalog){
      const item=node("article","wb-catalog-item");append(item,node("h3","",entry.title||entry.name||readable(entry.id)),
        node("p","",entry.question||entry.description||""));
      const industry=state.industrySet?.families?.find(f=>f.id===entry.id);
      if(industry)item.append(node("p","field-hint","Deliverable: "+industry.deliverable+
        " · general methodology only until case references are qualified."));
      for(const [label,values] of [["Inputs",entry.requiredInputs||entry.inputs],["Prerequisites",entry.prerequisites],["Possible findings",entry.possibleFindings||entry.findings],["Limits",entry.limits||entry.limitations]]){
        if(values){item.append(node("strong","muted-small",label));const ul=node("ul");
          for(const v of Array.isArray(values)?values:[values])ul.append(node("li","",v));item.append(ul);}
      }
      item.append(button("Select investigation",()=>{i.kind=entry.id;changed();renderInvestigation();},"button button-outline",true));list.append(item);
    }
    catalog.append(list);
    const hypotheses=repeat("Competing explanations","Preserve supporting and contradicting evidence. An unresolved explanation remains a valid outcome.",i.hypotheses,
      ()=>({id:id("hypothesis"),explanation:"",supportingEvidence:[],contradictingEvidence:[],status:"open"}),
      h=>grid(textField(h,"id","Hypothesis reference",{maxLength:96,required:true,pattern:"[A-Za-z0-9][A-Za-z0-9._:-]*"}),textField(h,"status","Reviewer-entered status",{choices:["open","supported","contradicted","unresolved"]}),
        paragraphs(h,"explanation","Explanation being tested"),
        linesField(h,"supportingEvidence","Supporting evidence references","One evidence identifier per line.",{maxItems:32,maxItemLength:500}),
        linesField(h,"contradictingEvidence","Contradicting evidence references","One evidence identifier per line.",{maxItems:32,maxItemLength:500})),renderInvestigation);
    const actions=repeat("Next investigations and actions","Assign the next observation or responsible review without asserting it already happened.",i.nextActions,
      ()=>({id:id("action"),action:"",owner:"",dueDate:"",status:"pending"}),a=>grid(
        textField(a,"id","Action reference",{maxLength:96,required:true,pattern:"[A-Za-z0-9][A-Za-z0-9._:-]*"}),textField(a,"status","Status",{choices:["pending","done","blocked"]}),
        paragraphs(a,"action","Next action"),textField(a,"owner","Responsible owner"),textField(a,"dueDate","Due date",{type:"date"})),renderInvestigation);
    panel("investigation",charter,catalog,hypotheses,actions);
  }
  function renderEngineering(){
    const e=state.draft.engineering;
    const c=card("Mechanical, tooling, and layout evidence","Prepare the design and physical-investigation packet. Required local checks can remain pending.");
    c.append(grid(paragraphs(e,"requirements","Requirements, dimensions, and GD&T considerations"),
      paragraphs(e,"designReferences","Versioned CAD, drawing, and layout references"),
      paragraphs(e,"inspectionPlan","Measurement and inspection plan"),
      paragraphs(e,"localChecks","Physical checks and local observations required"),
      paragraphs(e,"alternatives","Fixture concepts, layout alternatives, and constraints"),
      textField(e,"reviewOwner","Responsible engineering reviewer"),
      textField(e,"disposition","Review disposition",{choices:["pending","reviewed","needs-investigation"]})));
    panel("engineering",c,help("Physical acceptance","Record the responsible review and its evidence. A design reference or completed remote review does not itself establish physical fit, safe installation, or production acceptance."));
  }
  function renderImprovement(){
    const i=state.draft.improvement;
    const proposal=card("Intervention and approval","Keep the proposed change, responsible decision, implementation, and observed outcome separate.");
    proposal.append(grid(paragraphs(i,"alternatives","Alternatives and tradeoffs"),paragraphs(i,"proposal","Selected proposal"),
      textField(i,"approver","Responsible approver"),textField(i,"decision","Recorded human decision",{choices:["pending","approved","rejected","revise","abandoned"]}),
      paragraphs(i,"decisionReference","Decision evidence / reference"),
      paragraphs(i,"pilotPlan","Pilot plan"),paragraphs(i,"acceptanceMeasures","Acceptance measures and conditions")));
    const control=card("Implementation and sustained control","Document what happened, what changed for affected groups, and who responds if performance or working conditions deteriorate.");
    control.append(grid(paragraphs(i,"implementationRecord","Implementation record"),
      paragraphs(i,"adverseEffects","Adverse effects and receiving-team impact"),
      paragraphs(i,"controlPlan","Control plan"),paragraphs(i,"reactionPlan","Reaction plan"),
      textField(i,"handoffOwner","Handoff owner",{full:true})));
    panel("improvement",proposal,control);
  }
  function renderWorkers(){
    const w=state.draft.workerOutcomes;
    const voice=card("Worker-defined needs and contributions","Capture shared concerns and contribution evidence without placing private individual information in ordinary exports.");
    voice.append(grid(paragraphs(w,"requests","Worker-defined problems and requests"),
      paragraphs(w,"affectedGroups","Affected groups, including receiving teams and contractors"),
      paragraphs(w,"contributionEvidence","Contribution evidence"),
      paragraphs(w,"workloadImplications","Workload, safety, predictability, and autonomy"),
      paragraphs(w,"earningsImplications","Earnings and schedule implications")));
    const returns=card("Benefits, commitments, and delivery","Keep a desired benefit, an authorized commitment, and evidence of delivery distinguishable.");
    returns.append(grid(paragraphs(w,"proposedBenefits","Proposed benefits and distribution"),
      textField(w,"commitmentAuthority","Person authorized to make the commitment",{full:true}),
      paragraphs(w,"commitmentReference","Authorized commitment reference"),
      paragraphs(w,"deliveryEvidence","Evidence of actual delivery"),
      paragraphs(w,"disputes","Disputed outcomes and unresolved concerns")));
    const guide=help("Financial assessment","The Evidence & assessment section includes a worker-benefit assessment. It keeps avoided cash cost, released capacity, and nonfinancial outcomes distinct and calculates only from the supplied evidence.");
    guide.append(button("Open evidence and assessment",()=>chooseTab("evidence",true),"button button-outline"));
    const contents=[voice,returns,guide];
    if(state.privateNotesAllowed)contents.push(privateNoteCard());
    panel("workers",...contents);
  }

  function privateNoteCard(){
    const c=card("Restricted worker note","This separate note is available to application operators and is excluded from ordinary case history and handoff exports. Record only information appropriate for that access policy.");
    if(!state.saved){c.append(node("p","wb-empty-list","Save the case before using its restricted note."));return c;}
    c.append(button("Load saved restricted note",loadPrivateNote));
    if(state.privateNote){
      const status=node("p","field-hint","Restricted note version "+state.privateNote.version+(state.privateDirty?" · unsaved changes":""));
      status.id="wb-private-status";status.setAttribute("role","status");c.append(status);
      c.append(field("Restricted note",state.privateDraft,value=>{state.privateDraft=value;state.privateDirty=true;},
        {lines:5,maxLength:8000,full:true,contextOnly:true}));
      const save=button(state.pending?.kind==="private"?"Retry pending note save":"Save restricted note",savePrivateNote);
      save.id="wb-retry-extra";save.disabled=state.busy||!!state.pending&&state.pending.kind!=="private";
      c.append(append(node("div","wb-small-actions"),save));
    }
    return c;
  }
  async function loadPrivateNote(){
    if(!state.saved||!state.privateNotesAllowed||state.busy||state.pending)return;
    if(state.privateDirty&&!window.confirm("Discard your unsaved restricted note and load the saved version?"))return;
    const caseId=state.saved.caseId;
    try{const result=await api("/api/workbench/private-note?caseId="+encodeURIComponent(caseId));
      if(state.saved?.caseId!==caseId)return;
      state.privateNote=result.privateNote;state.privateDraft=result.privateNote.note;state.privateDirty=false;renderWorkers();
    }catch(error){notice(errorMessage(error),"error");}
  }
  async function savePrivateNote(){
    if(!state.saved||!state.privateNote||!state.privateNotesAllowed)return;
    await extraMutation("private","/api/workbench/private-note",{actionId:crypto.randomUUID(),caseId:state.saved.caseId,
      expectedVersion:state.privateNote.version,note:state.privateDraft});
  }
  async function extraMutation(kind,path,payload){
    if(state.busy||!canEdit()||state.pending&&state.pending.kind!==kind)return;
    if(!state.pending)state.pending={kind,path,payload};
    state.busy=true;updateControls();
    try{
      const request=state.pending;
      const result=await api(request.path,{method:"POST",headers:{"Content-Type":"application/json","X-FDE-Request":"workbench"},body:JSON.stringify(request.payload)});
      if(kind==="private"){
        if(result.privateNote?.caseId!==state.saved.caseId||!Number.isInteger(result.privateNote.version)||typeof result.privateNote.note!=="string")throw Error("invalid-private-note-response");
        state.pending=null;
        state.privateNote=result.privateNote;state.privateDraft=result.privateNote.note;state.privateDirty=false;renderWorkers();
        notice("Restricted note saved separately. It is excluded from ordinary exports.");
      }else{
        if(!result.import?.importId||result.import.caseId!==state.saved.caseId)throw Error("invalid-source-pin-response");
        state.pending=null;
        state.imports=[...state.imports.filter(p=>p.importId!==result.import.importId),result.import];renderEvidence();
        notice("Existing W1 evidence pinned by the host. No fresh source read occurred.");
      }
    }catch(error){
      if([400,401,403,404,409,413,415,422].includes(error.status))state.pending=null;
      notice(errorMessage(error)+(state.pending?" Retry the same action to resolve its status safely.":""),"error");
      if(kind==="private")renderWorkers();else renderEvidence();
    }finally{state.busy=false;updateControls();}
  }


  const concerns=["reporting-discrepancy","pdm-bom","flow-setup","quality-measurement","tooling","layout","maintenance","reporting-signage"];
  const evidenceHint="One saved evidence identifier per line. References retain their synthetic or manually supplied origin.";
  function emptyInvestigation(kind){
    const observation=()=>({samples:[],unit:"s",population:"",method:"",basis:"operator-observation",conditions:"",window:"",measurementQuality:"unknown"});
    if(kind==="pdm")return {kind,partId:"",configuration:"",requiredRevision:null,observedRevision:null,identity:"unknown",release:"unknown",
      effectivity:"unknown",approvedAlternate:false,changeApproved:false,changePropagated:null,engineeringQuantity:null,manufacturingQuantity:null,
      engineeringUnit:null,manufacturingUnit:null,evidenceRefs:[]};
    if(kind==="bom")return {kind,assemblyId:"",configuration:"",requiredRevision:null,observedRevision:null,release:"unknown",effectivity:"unknown",
      engineeringLines:[],manufacturingLines:[],substitutions:[],selectedPart:null,selectedRevision:null,whereUsed:[],evidenceRefs:[]};
    if(kind==="process")return {kind,measure:"cycle",baseline:observation(),followup:observation(),evidenceRefs:[]};
    if(kind==="mechanical")return {kind,mode:"tooling",requirements:[],designs:[],measurements:[],localObservations:[],reviewer:null,
      acceptance:"pending",acceptanceEvidence:[],evidenceRefs:[]};
    if(kind==="worker-benefit")return {kind,currency:"USD",cashItems:[],costItems:[],cashScope:"unverified",releasedHours:null,
      nonfinancialOutcome:null,observation:"unobserved",allocationPercent:null,commitment:"uncommitted",deliveredAmount:null,deliveryEvidence:[],evidenceRefs:[]};
    return {kind:"triage",concern:"reporting-discrepancy",availableEvidence:[],measurementReady:false,workerConcern:false};
  }
  function renderEvidence(){
    const d=state.draft;
    const records=repeat("Evidence register","These entries are synthetic evidence or manually supplied references. They cannot create host-acquired source receipts.",d.evidence,
      ()=>({id:id("evidence"),title:"",reference:"",revision:"",observedAt:"",origin:"manual-reference",limitations:""}),
      e=>grid(textField(e,"id","Evidence identifier",{maxLength:96,required:true,pattern:"[A-Za-z0-9][A-Za-z0-9._:-]*"}),textField(e,"title","Evidence title"),
        textField(e,"reference","Document / source reference"),textField(e,"revision","Version or revision"),
        textField(e,"observedAt","Observation date/time",{hint:"ISO date/time including timezone, when known."}),
        textField(e,"origin","Origin",{choices:[["manual-reference","Manually supplied reference"],["synthetic","Synthetic evidence"]]}),
        paragraphs(e,"limitations","Coverage, freshness, and limitations")),renderEvidence);
    const assessment=card("Assessment inputs","Choose an assessment for the saved observations. Its findings retain the evidence references, assumptions, and unresolved questions.");
    const input=d.semanticInput.investigation;
    assessment.append(field("Assessment type",input.kind,value=>{
      if(value===input.kind)return;
      if(!window.confirm("Changing assessment type replaces the inputs in this draft. Previously saved assessment history is retained. Continue?")){renderEvidence();return;}
      d.semanticInput={schema:"fde.industrial-assessment-request/v1",investigation:emptyInvestigation(value)};
      changed();renderEvidence();
    },{choices:[["triage","Investigation selection"],["pdm","Part / revision applicability"],["bom","Assembly BOM, substitutions, and where-used"],["process","Process and quality comparison"],
      ["mechanical","Tooling, layout, and inspection evidence"],["worker-benefit","Worker-benefit accounting"]],full:true}));
    assessment.append(node("p","field-hint","Save this case before assessing it. Assessment history is pinned to the saved inputs and version."));
    if(input.kind==="triage")assessment.append(triageFields(input));
    else if(input.kind==="pdm")assessment.append(pdmFields(input));
    else if(input.kind==="bom")assessment.append(bomFields(input));
    else if(input.kind==="process")assessment.append(processFields(input));
    else if(input.kind==="mechanical")assessment.append(mechanicalFields(input));
    else if(input.kind==="worker-benefit")assessment.append(workerFields(input));
    const results=card("Recorded assessment","Findings describe the saved inputs and their limits. Editing the draft does not change a recorded assessment.");
    if(state.evaluation)results.append(renderAssessment(state.evaluation));
    else results.append(node("p","wb-empty-list","No assessment selected. Save the case, then choose Assess saved evidence."));
    panel("evidence",records,sourceImportCard(),assessment,results);
  }
  function sourceImportCard(){
    const c=card("Host-pinned W1 evidence","An existing admitted W1 observation can be pinned only through the host's separately provisioned source permission. A manual evidence entry cannot create this provenance.");
    if(state.sourceImportsEnabled&&state.saved){
      c.append(grid(field("Host source",state.importSourceId,v=>{state.importSourceId=v;},
        {choices:[["w1-observations","W1 admitted observations"]],contextOnly:true,hint:"This host permits separately authorized pins from its saved W1 observations."}),
        field("Existing W1 observation ID",state.importObservationId,v=>{state.importObservationId=v;},
        {maxLength:68,contextOnly:true,hint:"An obs- identifier from the saved W1 case room."})));
      const importButton=button(state.pending?.kind==="import"?"Retry pending evidence pin":"Pin existing W1 observation",()=>{
        if(!state.saved||state.dirty)return;
        void extraMutation("import","/api/workbench/import-w1",{actionId:crypto.randomUUID(),caseId:state.saved.caseId,
          expectedVersion:state.saved.version,sourceId:state.importSourceId.trim(),observationId:state.importObservationId.trim()});
      });
      importButton.id="wb-retry-import";importButton.disabled=!canEdit()||state.busy||state.dirty||!!state.pending&&state.pending.kind!=="import";
      c.append(append(node("div","wb-small-actions"),importButton));
      if(state.dirty)c.append(node("p","field-hint","Save the case before pinning a source observation."));
    }else c.append(node("p","wb-empty-list",state.sourceImportsEnabled?"Save the case before pinning existing source evidence.":"Source pinning is not enabled on this host."));
    if(state.importsTruncated)c.append(node("p","field-hint","The host returned a bounded page of source pins. Earlier pins remain in the application store."));
    for(const pin of state.imports){
      const rows=node("dl","wb-readout");
      for(const [label,value] of [["Import",pin.importId],["Source",pin.sourceId],["Observation",pin.observationId],["Pinned at",pin.createdAt],["Case version",pin.caseVersion]])
        append(rows,node("dt","",label),node("dd","",value));
      c.append(rows);
      if(pin.receipt===null||pin.access==="withheld-current-permission")
        c.append(node("p","note-warning","The host withheld this source receipt because current permission is unavailable. Its metadata remains visible, but the receipt contents are excluded from this view. Exports recheck current permission."));
    }
    return c;
  }
  function triageFields(i){
    return grid(textField(i,"concern","Reported concern",{choices:concerns}),
      boolField(i,"measurementReady","Measurement prerequisites ready?","Select Yes only when the measurement basis is available."),
      boolField(i,"workerConcern","Does the concern involve worker conditions?"),
      linesField(i,"availableEvidence","Available evidence references",evidenceHint));
  }
  function pdmFields(i){
    return grid(textField(i,"partId","Part identifier"),textField(i,"configuration","Configuration / applicability context"),
      textField(i,"requiredRevision","Applicable required revision",{nullable:true,hint:"Leave blank when applicability is unknown. The latest revision is not assumed applicable."}),
      textField(i,"observedRevision","Revision observed at point of use",{nullable:true}),
      textField(i,"identity","Part identity evidence",{choices:["unknown","confirmed","conflicting"]}),
      textField(i,"release","Required definition release status",{choices:["unknown","draft","released"]}),
      textField(i,"effectivity","Effectivity for this configuration",{choices:["unknown","applicable","not-applicable"]}),
      boolField(i,"approvedAlternate","Approved alternate?","Record the evidence for the alternate in the register."),
      boolField(i,"changeApproved","Engineering change approved?"),
      triBoolField(i,"changePropagated","Change reached the point of use?"),
      textField(i,"engineeringQuantity","Engineering BOM quantity",{nullable:true,decimal:true,maxLength:64,hint:"Exact decimal, or blank when unknown."}),
      textField(i,"engineeringUnit","Engineering BOM unit",{nullable:true}),
      textField(i,"manufacturingQuantity","Manufacturing BOM quantity",{nullable:true,decimal:true,maxLength:64}),
      textField(i,"manufacturingUnit","Manufacturing BOM unit",{nullable:true}),
      linesField(i,"evidenceRefs","Evidence references",evidenceHint));
  }
  function bomFields(i){
    const wrap=node("div");
    wrap.append(grid(textField(i,"assemblyId","Assembly identifier",{maxLength:240}),
      textField(i,"configuration","Configuration / applicability context",{maxLength:240}),
      textField(i,"requiredRevision","Applicable assembly revision",{nullable:true,maxLength:240}),
      textField(i,"observedRevision","Assembly revision observed at point of use",{nullable:true,maxLength:240}),
      textField(i,"release","Required definition release status",{choices:["unknown","draft","released"]}),
      textField(i,"effectivity","Effectivity for this configuration",{choices:["unknown","applicable","not-applicable"]})));
    const newLine=()=>({position:"",partId:"",revision:"",quantity:"",unit:""});
    const lineFields=line=>grid(textField(line,"position","BOM position",{maxLength:240}),
      textField(line,"partId","Part identifier",{maxLength:240}),textField(line,"revision","Part revision",{maxLength:240}),
      textField(line,"quantity","Exact quantity",{decimal:true,maxLength:64}),textField(line,"unit","Explicit unit",{maxLength:240}));
    wrap.append(repeat("Engineering BOM lines","Enter the applicable engineering definition. Each position must be unique within this BOM.",i.engineeringLines,
      newLine,lineFields,renderEvidence,128));
    wrap.append(repeat("Manufacturing BOM lines","Enter the definition observed in manufacturing using its own positions, quantities, and explicit units.",i.manufacturingLines,
      newLine,lineFields,renderEvidence,128));
    wrap.append(repeat("Approved substitutions","Record each asserted substitution and its approval evidence. The assessment interprets its applicability and quantity relationship.",i.substitutions,
      ()=>({position:"",requiredPartId:"",requiredRevision:"",actualPartId:"",actualRevision:"",quantityFactor:"",approvalRef:""}),
      s=>grid(textField(s,"position","Applicable BOM position",{maxLength:240}),
        textField(s,"requiredPartId","Required part",{maxLength:240}),textField(s,"requiredRevision","Required revision",{maxLength:240}),
        textField(s,"actualPartId","Substitute part",{maxLength:240}),textField(s,"actualRevision","Substitute revision",{maxLength:240}),
        textField(s,"quantityFactor","Approved quantity factor",{decimal:true,maxLength:64,hint:"Exact positive factor from the approved relationship."}),
        textField(s,"approvalRef","Approval evidence identifier",{full:true,maxLength:240,hint:"Include this identifier in the assessment evidence references."})),renderEvidence,128));
    const query=card("Where-used question","Identify a part and revision, then supply the relevant parent-child relationships. The assessment traverses only the supplied configuration and revision evidence.");
    query.append(grid(textField(i,"selectedPart","Part to investigate",{nullable:true,maxLength:240}),
      textField(i,"selectedRevision","Part revision to investigate",{nullable:true,maxLength:240})));
    wrap.append(query);
    wrap.append(repeat("Where-used relationships","Keep every parent, child, revision, and configuration explicit. Supply the evidence for each relationship.",i.whereUsed,
      ()=>({parentId:"",parentRevision:"",childId:"",childRevision:"",configuration:"",evidenceRef:""}),
      u=>grid(textField(u,"parentId","Parent identifier",{maxLength:240}),textField(u,"parentRevision","Parent revision",{maxLength:240}),
        textField(u,"childId","Child identifier",{maxLength:240}),textField(u,"childRevision","Child revision",{maxLength:240}),
        textField(u,"configuration","Relationship configuration",{maxLength:240}),
        textField(u,"evidenceRef","Relationship evidence identifier",{maxLength:240})),renderEvidence,128));
    wrap.append(linesField(i,"evidenceRefs","All evidence referenced by this assessment",evidenceHint));
    return wrap;
  }
  function observationFields(o,title){
    const f=node("fieldset","wb-repeat-row");f.append(node("legend","",title));
    f.append(grid(linesField(o,"samples","Observed samples","One exact decimal per line. Preserve the original measurement basis; do not substitute order duration for operator cycle time.",{maxLength:16000,maxItemLength:64}),
      textField(o,"unit","Unit",{choices:[["s","Seconds"],["min","Minutes"],["h","Hours"],["percent","Percent"]]}),
      textField(o,"basis","Observation basis",{choices:["operator-observation","machine-observation","order-elapsed","inspection"]}),
      textField(o,"population","Population / product and shift"),textField(o,"method","Measurement method"),
      textField(o,"conditions","Operating conditions"),textField(o,"window","Observation window"),
      textField(o,"measurementQuality","Measurement quality",{choices:["unknown","adequate","inadequate"]})));
    return f;
  }
  function processFields(i){
    const wrap=node("div");
    wrap.append(grid(textField(i,"measure","Measure",{choices:["cycle","touch","queue","setup","downtime","rework","defect-rate","first-pass-yield"],full:true})),
      observationFields(i.baseline,"Baseline observations"),observationFields(i.followup,"Follow-up observations"),
      linesField(i,"evidenceRefs","Evidence references",evidenceHint));
    return wrap;
  }
  function mechanicalFields(i){
    return grid(textField(i,"mode","Investigation",{choices:["tooling","layout","inspection"]}),
      textField(i,"reviewer","Responsible reviewer",{nullable:true}),
      linesField(i,"requirements","Requirement evidence references",evidenceHint),
      linesField(i,"designs","Design / drawing / layout references",evidenceHint),
      linesField(i,"measurements","Measurement evidence references",evidenceHint),
      linesField(i,"localObservations","Local physical observation references",evidenceHint),
      textField(i,"acceptance","Recorded acceptance decision",{choices:["pending","accepted","rejected"],hint:"A recorded decision does not itself certify physical acceptance."}),
      linesField(i,"acceptanceEvidence","Acceptance decision evidence",evidenceHint),
      linesField(i,"evidenceRefs","All evidence referenced by this assessment","Every reference above must be included here and linked to the evidence register."));
  }
  function workerFields(i){
    const wrap=node("div");
    wrap.append(grid(textField(i,"currency","Currency",{choices:["USD","EUR","GBP"]}),
      textField(i,"cashScope","Cash item scope",{choices:[["unverified","Overlap has not been ruled out"],["nonoverlapping","Evidence supports non-overlapping items"]]})));
    wrap.append(repeat("Avoided cash costs","Use actual avoided cash items with distinct references. Released capacity is recorded separately.",i.cashItems,
      ()=>({id:id("cash"),amount:"",evidenceRef:""}),item=>grid(textField(item,"id","Cash item identifier"),
        textField(item,"amount","Amount",{decimal:true,maxLength:64,hint:"Exact nonnegative decimal."}),
        textField(item,"evidenceRef","Evidence identifier",{maxLength:240,full:true,hint:"Link this item to its evidence and include the identifier below."})),renderEvidence));
    wrap.append(repeat("Implementation costs","Record applicable costs once, with distinct references.",i.costItems,
      ()=>({id:id("cost"),amount:"",evidenceRef:""}),item=>grid(textField(item,"id","Cost item identifier"),
        textField(item,"amount","Amount",{decimal:true,maxLength:64}),
        textField(item,"evidenceRef","Evidence identifier",{maxLength:240,full:true,hint:"Link this cost to its evidence and include the identifier below."})),renderEvidence));
    wrap.append(grid(textField(i,"releasedHours","Released capacity (hours)",{nullable:true,decimal:true,maxLength:64,hint:"Capacity is not automatically cash savings."}),
      textField(i,"observation","Operational outcome observation",{choices:["unobserved","observed","disputed"]}),
      textField(i,"nonfinancialOutcome","Nonfinancial outcome",{nullable:true,lines:3,full:true,hint:"Describe workload, safety, predictability, autonomy, or other working-condition changes."}),
      textField(i,"allocationPercent","Proposed / authorized allocation (%)",{nullable:true,decimal:true,maxLength:64}),
      textField(i,"commitment","Distribution commitment",{choices:["uncommitted","authorized","revoked"]}),
      textField(i,"deliveredAmount","Amount with delivery evidence",{nullable:true,decimal:true,maxLength:64}),
      linesField(i,"deliveryEvidence","Delivery evidence references",evidenceHint),
      linesField(i,"evidenceRefs","All evidence referenced by this assessment","Include the outcome, scope, costs, authorized commitment, and delivery references that support the supplied assertions.")));
    return wrap;
  }
  function renderAssessment(record){
    const result=record.result||record.assessment||record.interpretation||record;
    const wrap=node("div","wb-result");
    if(result.schema!=="fde.industrial-assessment/v1"){
      wrap.append(node("p","","The saved assessment is not available in a recognized display format."));return wrap;
    }
    if(result.authority!=="none"||result.vendorWriteAllowed!==false||result.physicalAcceptanceCertified!==false){
      wrap.append(node("p","","Assessment display refused: its authority boundary is not recognized."));return wrap;
    }
    wrap.append(node("h3","",readable(result.classification)));
    const meta=node("dl","wb-readout");
    for(const [label,value] of [["Assessment",result.kind],["Case version",record.caseVersion??record.version],
      ["Recorded at",record.createdAt],["Evaluation",record.evaluationId]]){
      if(value!==undefined)append(meta,node("dt","",label),node("dd","",value));
    }
    wrap.append(meta);
    if(result.findings?.length){
      const list=node("ul");
      for(const finding of result.findings)list.append(node("li","",
        readable(finding.status)+" — "+finding.detail+
        (finding.evidenceRefs?.length?" Evidence: "+finding.evidenceRefs.join(", "):"")));
      wrap.append(list);
    }
    if(result.metrics?.length){
      wrap.append(node("h3","wb-subheading","Exact metrics"));
      const metrics=node("dl","wb-readout");
      for(const metric of result.metrics)append(metrics,node("dt","",readable(metric.id)),
        node("dd","",metric.numerator+" / "+metric.denominator+" "+metric.unit));
      wrap.append(metrics,node("p","field-hint","Values retain their exact fraction; units appear beside each result."));
    }
    for(const [title,values] of [["Next investigations",result.nextInvestigations],["Limits",result.limitations]]){
      if(values?.length){wrap.append(node("h3","wb-subheading",title));const list=node("ul");
        for(const v of values)list.append(node("li","",v));wrap.append(list);}
    }
    return wrap;
  }
  async function loadHistory(afterVersion=null){
    if(!state.saved)return;
    const caseId=state.saved.caseId;
    try{
      const result=await api("/api/workbench/history?caseId="+encodeURIComponent(caseId)+(afterVersion===null?"":"&afterVersion="+afterVersion));
      if(state.saved?.caseId!==caseId)return;
      state.history=afterVersion===null?result.revisions||[]:[...state.history,...(result.revisions||[])];
      state.historyHasMore=result.hasMore===true;state.historyCursor=result.nextAfterVersion;
      renderHandoff();
    }catch(error){notice("The case is available, but its complete history could not be loaded. "+errorMessage(error),"warning");}
  }
  function download(payload,filename){
    downloadBlob(new Blob([JSON.stringify(payload,null,2)+"\n"],{type:"application/json"}),filename);
  }
  function downloadBlob(blob,filename){
    const url=URL.createObjectURL(blob);
    const link=node("a");link.download=filename;link.href=url;link.hidden=true;document.body.append(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1500);
  }
  async function exportCase(){
    if(!state.saved||state.busy||state.pending||state.exportBusy)return;
    const target={caseId:state.saved.caseId,version:state.saved.version};
    state.exportBusy=true;updateControls();
    try{
      const response=await fetch("/api/workbench/export?caseId="+encodeURIComponent(target.caseId),{cache:"no-store",credentials:"same-origin"});
      if(!response.ok){let value;try{value=await response.json();}catch{value=null;}const error=new Error(value?.code||"handoff-export-refused");error.status=response.status;throw error;}
      const type=(response.headers.get("content-type")||"").split(";")[0].trim();
      if(!["application/x-ndjson","application/ndjson"].includes(type))throw Error("handoff-format-refused");
      // Preserve the exact response bytes and content type. Only inspect bounded
      // envelope fragments; do not parse/rewrite the complete evidence stream.
      const blob=await response.blob();
      const prefix=await blob.slice(0,262144).text(),firstNewline=prefix.indexOf("\n");
      if(firstNewline<0)throw Error("handoff-manifest-missing");
      const manifest=JSON.parse(prefix.slice(0,firstNewline));
      if(manifest.schema!=="fde.workbench-handoff-stream/v1"||manifest.recordType!=="manifest"||
        manifest.privateWorkerNotesIncluded!==false||manifest.sourceWriteAllowed!==false)throw Error("handoff-boundary-refused");
      if(manifest.caseId!==target.caseId||manifest.caseVersion!==target.version){
        notice("The saved case changed before export. Reload it to review the version that will be included in the handoff.","warning");return;
      }
      const tail=await blob.slice(Math.max(0,blob.size-16384)).text();
      if(!tail.endsWith("\n"))throw Error("handoff-stream-incomplete");
      const records=tail.trimEnd().split("\n"),end=JSON.parse(records.at(-1));
      if(end.recordType!=="end"||end.complete!==true||end.caseId!==manifest.caseId||end.caseVersion!==manifest.caseVersion||
        !/^[a-f0-9]{64}$/.test(end.contentSha256))throw Error("handoff-stream-incomplete");
      for(const key of ["revisions","evaluations","imports"])if(end.counts?.[key]!==manifest.counts?.[key])throw Error("handoff-count-mismatch");
      downloadBlob(blob,"fde-workbench-handoff.jsonl");
      notice("Complete saved handoff for version "+target.version+" downloaded with all revision, assessment, and source-pin records. "+
        (end.withheldImports?end.withheldImports+" source receipt(s) were withheld under current permission. ":"")+"Restricted notes and unsaved draft changes are excluded.");
    }catch(error){notice(errorMessage(error),"error");}
    finally{state.exportBusy=false;updateControls();}
  }
  async function downloadIndustryBrief(){
    if(!state.saved||state.busy||state.pending||state.exportBusy)return;
    const target={caseId:state.saved.caseId,version:state.saved.version};
    state.exportBusy=true;updateControls();
    try{
      const uri="/api/workbench/industry-brief?caseId="+encodeURIComponent(target.caseId)+"&format=markdown";
      const response=await fetch(uri,{cache:"no-store",credentials:"same-origin"});
      if(!response.ok){
        let value=null;try{value=await response.json();}catch{}
        const error=new Error(value?.code||"industry-brief-unavailable");error.status=response.status;throw error;
      }
      if(response.headers.get("x-fde-case-version")!==String(target.version)||
         state.saved?.caseId!==target.caseId||state.saved?.version!==target.version)
        throw Error("saved-case-version-changed-during-industry-brief");
      if(!(response.headers.get("content-type")||"").startsWith("text/markdown"))
        throw Error("industry-brief-format-refused");
      const blob=await response.blob();
      if(blob.size===0||blob.size>60000)throw Error("industry-brief-size-refused");
      downloadBlob(blob,"fde-industry-brief-"+target.caseId+"-v"+target.version+".md");
      notice("Industry brief downloaded for saved version "+target.version+
        ". Haskell results are candidates; Knowledge references and physical outcomes still require review.");
    }catch(error){notice(errorMessage(error),"error");}
    finally{state.exportBusy=false;updateControls();}
  }
  async function replay(evaluationId){
    try{
      const result=await api("/api/workbench/replay?evaluationId="+encodeURIComponent(evaluationId));
      if(result.matched===true)notice("Pinned assessment replay matched the recorded result. No new source read occurred.");
      else notice("Replay did not report a confirmed match. Review the saved evaluation and runtime.","warning");
    }catch(error){notice(errorMessage(error),"error");}
  }
  function renderHandoff(){
    const c=card("Saved investigation handoff","Export the saved case, decision history, and assessment evidence for the next responsible person.");
    if(state.saved){
      const identity=node("dl","wb-readout");
      for(const [label,value] of [["Case",state.saved.caseId],["Version",state.saved.version],["Created",state.saved.createdAt],["Updated",state.saved.updatedAt]])
        append(identity,node("dt","",label),node("dd","",value));
      const exportButton=button("Download complete saved handoff",exportCase);exportButton.id="wb-export";
      exportButton.disabled=state.exportBusy||state.busy||!!state.pending;
      const industryButton=button("Download industry evidence brief",downloadIndustryBrief);
      industryButton.id="wb-industry-export";
      industryButton.disabled=state.exportBusy||state.busy||!!state.pending;
      c.append(identity,append(node("div","wb-small-actions"),exportButton,industryButton,button("Refresh history",()=>loadHistory())));
      c.append(node("p","field-hint","The industry brief follows the saved case, Haskell catalog and current diagnostic. Knowledge references still require separate review."));
      if(state.dirty)c.append(node("p","field-hint","The draft contains unsaved changes. The export contains only the saved version."));
    }else c.append(node("p","wb-empty-list","Save the case before exporting or reviewing its history."));
    const h=card("Case history","Recorded actions retain actor, version, and time.");
    const history=node("ol","wb-history");
    for(const event of state.history){
      const details=[event.createdAt||event.at,event.actor?.id||event.actor,
        event.version!==undefined?"version "+event.version:null,event.kind||event.action||event.operation].filter(v=>typeof v==="string"||typeof v==="number");
      const li=node("li");const detail=node("details");detail.append(node("summary","",details.join(" · ")));
      if(event.document){const view=node("dl","wb-readout");
        for(const [label,value] of [["Title",event.document.title],["Phase",event.document.investigation?.phase],
          ["Problem",event.document.investigation?.problem],["Proposal",event.document.improvement?.proposal],
          ["Decision",event.document.improvement?.decision],["Worker benefits",event.document.workerOutcomes?.proposedBenefits]])
          append(view,node("dt","",label),node("dd","",value||"Not recorded"));
        detail.append(view,button("Download this saved revision",()=>download({caseId:state.saved.caseId,...event},"fde-investigation-version-"+event.version+".json")));
      }
      li.append(detail);history.append(li);
    }
    if(!state.history.length)h.append(node("p","wb-empty-list","No history loaded."));
    else h.append(history);
    if(state.historyHasMore)h.append(button("Load more history",()=>loadHistory(state.historyCursor)));
    const assessments=card("Pinned assessments","Prior assessments remain attached to their saved case version. Selecting one does not overwrite the draft.");
    const values=state.evaluations.length?state.evaluations:state.evaluation?[state.evaluation]:[];
    if(state.evaluationsTruncated)assessments.append(node("p","field-hint","Showing the latest available assessment page. Earlier assessments remain in the application store."));
    if(!values.length)assessments.append(node("p","wb-empty-list","No saved assessments loaded."));
    for(const e of values){
      const row=node("div","wb-repeat-row");
      row.append(node("h3","",e.result?.kind||e.assessment?.kind||e.kind||"Assessment"));
      row.append(node("p","muted-small",[e.createdAt,e.caseVersion!==undefined?"case version "+e.caseVersion:null,e.evaluationId].filter(Boolean).join(" · ")));
      const actions=node("div","wb-small-actions");
      actions.append(button("Inspect assessment",()=>{state.evaluation=e;renderEvidence();chooseTab("evidence",true);}));
      if(e.evaluationId)actions.append(button("Verify pinned replay",()=>replay(e.evaluationId)));
      row.append(actions);assessments.append(row);
    }
    panel("handoff",c,h,assessments);
  }
  function render(){
    $("wb-empty").hidden=!!state.draft;$("wb-case").hidden=!state.draft;
    if(!state.draft){updateControls();return;}
    $("wb-case-heading").textContent=state.draft.title.trim()||"Untitled investigation";
    $("wb-case-meta").textContent=state.saved?"Version "+state.saved.version+" · "+state.saved.caseId:"Unsaved investigation draft";
    $("wb-origin").textContent="APPLICATION RECORD";
    renderEngagement();renderInvestigation();renderEvidence();renderEngineering();renderImprovement();renderWorkers();renderHandoff();
    chooseTab(state.tab);renderCases();updateControls();
  }
  for(const tab of document.querySelectorAll("[data-wb-tab]")){
    tab.addEventListener("click",()=>chooseTab(tab.dataset.wbTab));
    tab.addEventListener("keydown",event=>{
      const current=tabs.indexOf(tab.dataset.wbTab);
      let next;
      if(event.key==="ArrowRight")next=tabs[(current+1)%tabs.length];
      if(event.key==="ArrowLeft")next=tabs[(current+tabs.length-1)%tabs.length];
      if(event.key==="Home")next=tabs[0];if(event.key==="End")next=tabs[tabs.length-1];
      if(next){event.preventDefault();chooseTab(next,true);}
    });
  }
  let searchTimer;
  $("wb-search").addEventListener("input",()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{void loadCases().catch(error=>notice(errorMessage(error),"error"));},250);});
  $("wb-list-next").addEventListener("click",()=>{if(state.listLoading||state.listNextOffset===null)return;void loadCases(state.listNextOffset,"next").catch(error=>notice(errorMessage(error),"error"));});
  $("wb-list-previous").addEventListener("click",()=>{if(state.listLoading||!state.listPrevious.length)return;void loadCases(state.listPrevious.at(-1),"previous").catch(error=>notice(errorMessage(error),"error"));});
  $("wb-new").addEventListener("click",newCase);
  $("wb-empty-new").addEventListener("click",newCase);
  $("wb-save").addEventListener("click",()=>mutate("save"));
  $("wb-assess").addEventListener("click",()=>mutate("assess"));
  $("wb-reload").addEventListener("click",()=>{if(state.saved)void openCase(state.saved.caseId);});
  window.addEventListener("beforeunload",event=>{if(state.dirty||state.privateDirty||state.pending){event.preventDefault();event.returnValue="";}});
  async function start(){
    try{
      state.session=await api("/api/session");
      $("wb-session").textContent=state.session.principal.id+" · "+state.session.principal.role;
      const result=await api("/api/workbench/catalog");
      state.catalog=result.catalog||result.investigations||result.entries||[];
      state.industrySet=result.industrySet?.schema==="fde.industry-set/v1"&&
        result.industrySet.authority==="none"&&result.industrySet.sourceWriteAllowed===false?
        result.industrySet:null;
      state.emptyDocument=result.emptyDocument;
      state.sourceImportsEnabled=result.sourceImportsEnabled===true;state.privateNotesAllowed=result.privateNotesAllowed===true;
      if(!state.emptyDocument)throw Error("workbench-template-unavailable");
      await loadCases();updateControls();
    }catch(error){
      $("wb-list-status").textContent="Saved workbench unavailable";
      notice(error.status===404?"This host does not provide the saved industrial workbench. Open the authenticated application host.":errorMessage(error),"error");
      updateControls();
    }
  }
  void start();
})();
