/** Independent finite transport fixture, not a production interpreter. */
export function industrialBudgetFixture(){
  const engineeringLines=Array.from({length:128},(_,n)=>({position:String(n+1),partId:`P-${n+1}`,
    revision:"A",quantity:"2",unit:"piece",evidenceRef:"ebom"}));
  const manufacturingLines=engineeringLines.map(line=>({...line,revision:"B",unit:"box",evidenceRef:"mbom"}));
  const whereUsed=Array.from({length:128},(_,n)=>({parentId:`ASSEMBLY-${n+1}`,parentRevision:"1",
    childId:n===0?"LEAF":`ASSEMBLY-${n}`,childRevision:"1",configuration:"plant-A",evidenceRef:"uses"}));
  const semanticInput={schema:"fde.industrial-assessment-request/v1",investigation:{kind:"bom",assemblyId:"ASSEMBLY-1",
    configuration:"plant-A",requiredRevision:"R1",observedRevision:"R1",release:"released",effectivity:"applicable",
    engineeringLines,manufacturingLines,substitutions:[],selectedPart:"LEAF",selectedRevision:"1",whereUsed,
    evidenceRefs:["ebom","mbom","uses"]}};
  const evidenceInventory=["ebom","mbom","uses"].map(id=>({id,origin:"synthetic",revision:"r1",
    observedAt:"2026-10-31T12:00:00Z",limitations:"",reference:`fixture:${id}`}));
  // Four findings for each of128 mismatching rows,128 ancestors, two context findings.
  return {semanticInput,evidenceInventory,expected:{classification:"bom-lines-differ",findings:642,
    ancestorCount:{numerator:"128",denominator:"1",unit:"assembly-revisions"},maxReferencesPerFinding:2}};
}
