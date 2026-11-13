// Public source: no private hardcoded compiler, library paths or scratch directory.
export function localToolchain(){
  return {...process.env};
}
