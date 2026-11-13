{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE RecordWildCards #-}
module FDE.AdmissionWire (processAdmission, renderSnapshot, renderAdmission) where
import Control.Monad (unless)
import Data.Aeson (Value(..), object, withObject, (.:), (.=))
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import Data.Aeson.Types (Parser, parseEither)
import Data.List (sort)
import Data.Text (Text)
import FDE.Admission
import FDE.Kernel
import FDE.Wire (parseInput, renderDecision)

exact :: [Text] -> KM.KeyMap Value -> Parser ()
exact names obj = unless (sort (map Key.toText (KM.keys obj)) == sort names)
  (fail "closed-admission-schema")

parseContext :: Value -> Parser Context
parseContext = withObject "W1 context" $ \o -> do
  exact ["caseId","candidateSetId","admissionId","assessmentId","evaluationId","policyId","mappingId","kernelContract"] o
  Context <$> o .: "caseId" <*> o .: "candidateSetId" <*> o .: "admissionId"
    <*> o .: "assessmentId" <*> o .: "evaluationId" <*> o .: "policyId"
    <*> o .: "mappingId" <*> o .: "kernelContract"

parseReceipt :: Value -> Parser Receipt
parseReceipt = withObject "source receipt" $ \o -> do
  exact ["receiptId","role","sourceInstance","sourceNativeId","sourceRevision","observedAt","querySha256","authentication"] o
  Receipt <$> o .: "receiptId" <*> o .: "role" <*> o .: "sourceInstance"
    <*> o .: "sourceNativeId" <*> o .: "sourceRevision" <*> o .: "observedAt"
    <*> o .: "querySha256" <*> o .: "authentication"

parseMember :: Value -> Parser Member
parseMember = withObject "candidate member" $ \o -> do
  exact ["candidateId","role","kind","receiptId","sourceNativeId","sourceRevision","quantity","unit"] o
  Member <$> o .: "candidateId" <*> o .: "role" <*> o .: "kind"
    <*> o .: "receiptId" <*> o .: "sourceNativeId" <*> o .: "sourceRevision"
    <*> o .: "quantity" <*> o .: "unit"

parseFields :: KM.KeyMap Value -> Parser Admission
parseFields o = do
  context <- parseContext =<< o .: "context"
  inputValue <- o .: "input"
  pinnedInput <- either (fail . show) pure (parseInput inputValue)
  receipts <- traverse parseReceipt =<< o .: "receipts"
  members <- traverse parseMember =<< o .: "members"
  pure Admission{..}

parseAdmission :: Value -> Parser Admission
parseAdmission = withObject "W1 admission" $ \o -> do
  exact ["schema","context","input","receipts","members"] o
  schema <- o .: "schema"
  unless (schema == ("fde.w1-admission-request/v1" :: Text)) (fail "admission-schema")
  parseFields o

renderContext :: Context -> Value
renderContext Context{..} = object
  ["caseId" .= caseId,"candidateSetId" .= candidateSetId,"admissionId" .= admissionId
  ,"assessmentId" .= assessmentId,"evaluationId" .= evaluationId,"policyId" .= policyId
  ,"mappingId" .= mappingId,"kernelContract" .= kernelContract]

renderSource :: Source -> Value
renderSource Source{..} = object
  [ "schema" .= ("fde.native-observation/v1" :: Text), "dataClass" .= sourceClass
  , "role" .= role, "vendor" .= vendor, "instance" .= instanceId, "nativeId" .= nativeId
  , "businessId" .= businessId, "revision" .= revision, "nativeState" .= nativeState
  , "planned" .= planned, "reported" .= reported, "unit" .= unit
  , "coverage" .= object ["order" .= ("exact-native-row" :: Text),"receipt" .= ("not-covered" :: Text)
                         ,"ledger" .= ("not-covered" :: Text),"physical" .= ("not-covered" :: Text)]
  , "capture" .= object ["observedAt" .= observedAt,"querySha256" .= queryDigest
       ,"mode" .= (if sourceClass == "handwritten-fixture" then ("fixture" :: Text) else "source-read-only")
       ,"transport" .= (if sourceClass == "handwritten-fixture" then ("not-applicable" :: Text) else "TLSv1.3")]]

renderInput :: CompileInput -> Value
renderInput CompileInput{..} = object
  ["schema" .= ("fde.case/v1" :: Text),"erp" .= renderSource erp,"mes" .= renderSource mes
  ,"binding" .= object ["schema" .= ("fde.native-binding/v1" :: Text),"grade" .= mappingGrade binding
    ,"unit" .= unitPolicy binding
    ,"erp" .= object ["instance" .= erpInstance binding,"nativeId" .= erpNativeId binding]
    ,"mes" .= object ["instance" .= mesInstance binding,"nativeId" .= mesNativeId binding]]]

renderReceipt :: Receipt -> Value
renderReceipt Receipt{..} = object
  ["receiptId" .= receiptId,"role" .= receiptRole,"sourceInstance" .= sourceInstance
  ,"sourceNativeId" .= sourceNativeId,"sourceRevision" .= sourceRevision
  ,"observedAt" .= receiptObservedAt,"querySha256" .= querySha256,"authentication" .= authentication]

renderMember :: Member -> Value
renderMember Member{..} = object
  ["candidateId" .= candidateId,"role" .= memberRole,"kind" .= memberKind
  ,"receiptId" .= memberReceiptId,"sourceNativeId" .= memberNativeId,"sourceRevision" .= memberRevision
  ,"quantity" .= memberQuantity,"unit" .= memberUnit]

fields :: Admission -> [ (Key.Key, Value) ]
fields Admission{..} =
  ["context" .= renderContext context,"input" .= renderInput pinnedInput
  ,"receipts" .= map renderReceipt receipts,"members" .= map renderMember members]

renderAdmission :: Admission -> Value
renderAdmission a = object (["schema" .= ("fde.w1-admission-request/v1" :: Text)] ++ fields a)

renderSnapshot :: Snapshot -> Value
renderSnapshot Snapshot{..} = object (fields admitted ++
  ["schema" .= ("fde.w1-admitted-review/v1" :: Text),"grade" .= evidenceGrade
  ,"authority" .= ("none" :: Text),"businessTruthSelected" .= False,"atomicSnapshot" .= False
  ,"postingPermitted" .= False,"physicalProductionCertified" .= False
  ,"decision" .= renderDecision decision])

parseSnapshot :: Value -> Parser Snapshot
parseSnapshot v = withObject "pinned W1 snapshot" (\o -> do
  exact ["schema","context","input","receipts","members","grade","authority","businessTruthSelected"
        ,"atomicSnapshot","postingPermitted","physicalProductionCertified","decision"] o
  a <- parseFields o
  snapshot <- either (fail . show) pure (admit a)
  unless (renderSnapshot snapshot == v) (fail "altered-pinned-snapshot")
  pure snapshot) v

processAdmission :: Value -> Either Text Value
processAdmission v = case parseEither parseRequest v of
  Left _ -> Left "invalid-admission-envelope"
  Right (Left a) -> renderSnapshot <$> admit a
  Right (Right (a,expected)) -> do
    snapshot <- replay a expected
    pure $ object ["schema" .= ("fde.w1-replay-result/v1" :: Text),"matched" .= True
      ,"readsFreshSources" .= False,"snapshot" .= renderSnapshot snapshot]
  where
    parseRequest = withObject "W1 request" $ \o -> do
      schema <- o .: "schema"
      if schema == ("fde.w1-admission-request/v1" :: Text)
        then Left <$> parseAdmission v
        else do
          unless (schema == ("fde.w1-replay-request/v1" :: Text)) (fail "unknown-admission-operation")
          exact ["schema","admission","expected"] o
          a <- parseAdmission =<< o .: "admission"
          expected <- parseSnapshot =<< o .: "expected"
          pure (Right (a,expected))
