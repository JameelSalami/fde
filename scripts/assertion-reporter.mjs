// Machine-readable Node test events. Error causes retain assertion identity and location.
function plain(value){
  if(value instanceof Error){const out={};for(const key of Object.getOwnPropertyNames(value))out[key]=plain(value[key]);return out;}
  if(Array.isArray(value))return value.map(plain);
  if(value&&typeof value==="object"){const out={};for(const [key,item] of Object.entries(value))out[key]=plain(item);return out;}
  return value;
}
export default async function* reporter(source){
  for await(const event of source){
    if(["test:pass","test:fail","test:summary"].includes(event.type))yield JSON.stringify(plain(event))+"\n";
  }
}
