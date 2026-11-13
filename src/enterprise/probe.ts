/** Explicit live READ ONLY observation of the existing fictional Chinese lab. */
import {admitCase,type ReviewCase} from "../model.js";
import {sourceAuth} from "./config.js";
import {readErp,ERP_INSTANCE,ERP_ORDER_NAME} from "./erpnext.js";
import {readMes,MES_INSTANCE,MES_NATIVE_ID} from "./openmes.js";

export async function readExistingLab():Promise<ReviewCase> {
  const {creds,ca}=await sourceAuth();
  // Separate read-only snapshots; no transaction across them.
  const [erp,mes]=await Promise.all([readErp(creds.erp),readMes(creds.mes,ca)]);
  return admitCase({
    schema:"fde.case/v1",erp,mes,
    binding:{
      schema:"fde.native-binding/v1",
      grade:"synthetic-native-import-reviewed",
      erp:{instance:ERP_INSTANCE,nativeId:ERP_ORDER_NAME},
      mes:{instance:MES_INSTANCE,nativeId:MES_NATIVE_ID},
      unit:"synthetic-pcs-equals-Nos"
    }
  });
}
