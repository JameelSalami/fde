{-# LANGUAGE OverloadedStrings #-}
module Main (main) where
-- Independent FDE-owned examples, deliberately not borrowed from archived projects.
import Control.Monad (unless,when)
import Data.Foldable (toList)
import System.Environment (getArgs)
import Data.Aeson (Value(..), object, (.=))
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import Data.Text (Text)
import qualified Data.Text as T
import FDE.Wire (parseInput,renderDecision)
import FDE.Kernel
import qualified FDE.History as H
import qualified FDE.Semantic as S
import System.Exit (exitFailure)

erpFixture :: Source
erpFixture = Source
  { role="erp", vendor="erpnext", instanceId="plantA", nativeId="W-75"
  , businessId="W-75", revision="rev-77", nativeState="Not Started"
  , planned="8.000000000", reported="1.250", unit="Nos"
  , sourceClass="handwritten-fixture", observedAt="2026-10-29T00:00:00Z"
  , queryDigest=T.replicate 64 "a" }

mesFixture :: Source
mesFixture = Source
  { role="mes", vendor="openmes", instanceId="siteB", nativeId="920"
  , businessId="B-75", revision="rev-42", nativeState="DONE"
  , planned="8.00", reported="5.875", unit="pcs"
  , sourceClass="handwritten-fixture", observedAt="2026-10-29T00:00:02Z"
  , queryDigest=T.replicate 64 "b" }

bindingFixture :: Binding
bindingFixture = Binding
  { erpInstance="plantA",erpNativeId="W-75",mesInstance="siteB",mesNativeId="920"
  , mappingGrade="synthetic-native-import-reviewed"
  , unitPolicy="synthetic-pcs-equals-Nos" }

example :: CompileInput
example = CompileInput {erp=erpFixture,mes=mesFixture,binding=bindingFixture}

check :: [String] -> String -> Bool -> IO ()
check names name passed = when (null names || elem (takeWhile (/= ' ') name) names) $ do
  putStrLn ((if passed then "PASS " else "FAIL ") <> name)
  unless passed exitFailure

get :: Text -> Value -> Maybe Value
get k (Object o) = KM.lookup (Key.fromText k) o
get _ _ = Nothing

getText :: Text -> Value -> Maybe Text
getText k v = case get k v of
  Just (String x) -> Just x
  _ -> Nothing

getBool :: Text -> Value -> Maybe Bool
getBool k v = case get k v of
  Just (Bool x) -> Just x
  _ -> Nothing

good :: CompileInput -> Maybe Decision
good = either (const Nothing) Just . compile

sourceJson :: Source -> Value
sourceJson x = object
  [ "schema" .= ("fde.native-observation/v1" :: Text)
  , "dataClass" .= sourceClass x, "role" .= role x, "vendor" .= vendor x
  , "instance" .= instanceId x, "nativeId" .= nativeId x
  , "businessId" .= businessId x, "revision" .= revision x
  , "nativeState" .= nativeState x
  , "planned" .= planned x, "reported" .= reported x, "unit" .= unit x
  , "coverage" .= object
     [ "order" .= ("exact-native-row" :: Text), "receipt" .= ("not-covered" :: Text)
     , "ledger" .= ("not-covered" :: Text), "physical" .= ("not-covered" :: Text) ]
  , "capture" .= object
     [ "observedAt" .= observedAt x, "querySha256" .= queryDigest x
     , "mode" .= ("fixture" :: Text), "transport" .= ("not-applicable" :: Text) ]
  ]

bindingJson :: Binding -> Value
bindingJson x = object
  [ "schema" .= ("fde.native-binding/v1" :: Text)
  , "grade" .= mappingGrade x, "unit" .= unitPolicy x
  , "erp" .= object ["instance" .= erpInstance x,"nativeId" .= erpNativeId x]
  , "mes" .= object ["instance" .= mesInstance x,"nativeId" .= mesNativeId x] ]

inputJson :: Value
inputJson = object
  [ "schema" .= ("fde.case/v1" :: Text)
  , "erp" .= sourceJson erpFixture
  , "mes" .= sourceJson mesFixture
  , "binding" .= bindingJson bindingFixture ]

main :: IO ()
main = do
  chosen <- getArgs
  let sample = good example
  check chosen "K01 source meaning diagnostic candidate" $
    maybe False ((== "reported-gap") . classification) sample
  check chosen "K02 wrong MES native identity refuses despite plausible quantity" $
    compile example{binding=bindingFixture{mesNativeId="921"}} == Left "unbound-native-identity"
  check chosen "K03 exact reporting difference 5.875 minus 1.250" $
    maybe False ((== "4.625") . reportedDelta) sample
  check chosen "K04 native extra-zero decimals leave plan aligned" $
    maybe False ((== "0.0") . plannedDelta) sample
  check chosen "K05 nonzero 9th-place fraction refuses rather than rounds" $
    compile example{erp=erpFixture{planned="8.000000001"}} == Left "invalid-exact-decimal"
  check chosen "K06 unknown native MES status indeterminate" $
    maybe False ((== "indeterminate-native-state") . classification)
      (good example{mes=mesFixture{nativeState="CUSTOM-STATE"}})
  check chosen "K07 equal reports remain non-authoritative" $
    case good example{mes=mesFixture{reported="1.250"}} of
      Nothing -> False
      Just x -> classification x == "aligned-reports" &&
        getBool "postingPermitted" (renderDecision x) == Just False &&
        getBool "businessTruthSelected" (renderDecision x) == Just False
  check chosen "K08 planning mismatch is separately classified" $
    maybe False ((== "plan-and-report-disagreement") . classification)
      (good example{mes=mesFixture{planned="9"}})
  check chosen "K09 origin identities survive semantic interpretation" $
    maybe False (\r -> getText "erpNativeId" (renderDecision r) == Just "W-75" &&
      getText "mesNativeId" (renderDecision r) == Just "920") sample
  check chosen "K10 Haskell result is not an admitted canonical truth" $
    maybe False (\r -> getText "admissionStatus" (renderDecision r) == Just "candidate-only" &&
      getBool "businessTruthSelected" (renderDecision r) == Just False) sample
  check chosen "K11 mutation proposal is permanently non-executable" $
    maybe False (\r -> case get "mutationCandidate" (renderDecision r) of
      Just v -> getBool "executable" v == Just False &&
        getText "targetSystem" v == Just "none"
      Nothing -> False) sample
  check chosen "K12 DONE doesn't imply receipt or physical output" $
    maybe False (\r -> getText "receiptCoverage" (renderDecision r) == Just "not-covered" &&
      getBool "physicalProductionCertified" (renderDecision r) == Just False) sample
  check chosen "K13 unfamiliar ERP status indeterminate" $
    maybe False ((== "indeterminate-native-state") . classification)
      (good example{erp=erpFixture{nativeState="CUSTOM"}})
  check chosen "K14 source candidates retain distinct plan and report fields" $
    maybe False (\r -> case get "candidates" (renderDecision r) of
      Just (Array xs) -> case toList xs of
        [ePlan,mPlan,eReport,mReport] ->
          getText "rootKind" ePlan == Just "WorkRequest" &&
          getText "rootKind" mPlan == Just "WorkRequest" &&
          getText "rootKind" eReport == Just "QuantityReport" &&
          getText "rootKind" mReport == Just "QuantityReport" &&
          getText "family" mReport == Just "SourceReport" &&
          getText "property" mReport == Just "reported-execution-quantity" &&
          getText "sourceNativeId" mReport == Just "920"
        _ -> False
      _ -> False) sample
  check chosen "K15 strict valid JSON envelope parses" (parseInput inputJson == Right example)
  check chosen "K16 unknown top-level field refuses" $
    case inputJson of
      Object o -> case parseInput (Object (KM.insert "unexpected" (String "bad") o)) of
        Left "invalid-compile-envelope" -> True
        _ -> False
      _ -> False
  check chosen "K17 wrong source vendor refuses during Haskell admission" $
    case parseInput $ object
      [ "schema" .= ("fde.case/v1" :: Text)
      , "erp" .= sourceJson erpFixture{vendor="openmes"}
      , "mes" .= sourceJson mesFixture
      , "binding" .= bindingJson bindingFixture ] of
      Right candidate -> compile candidate == Left "wrong-native-source"
      _ -> False
  let pathA = H.Path "planned" "closed"
        [H.Edge "e-a" "ERP" "planned" "executed" "native-report" "receipt-a"
        ,H.Edge "e-b" "MES" "executed" "closed" "witnessed" "receipt-b"]
      pathB = H.Path "planned" "closed"
        [H.Edge "e-c" "ERP" "planned" "held" "review" "receipt-c"
        ,H.Edge "e-d" "MES" "held" "closed" "witnessed" "receipt-d"]
      stageA = H.Path "planned" "executed" [H.Edge "e-a" "ERP" "planned" "executed" "native-report" "receipt-a"]
      stageB = H.Path "executed" "closed" [H.Edge "e-b" "MES" "executed" "closed" "witnessed" "receipt-b"]
  check chosen "K18 separate full causal paths are not merged by equal endpoints" $
    H.eitherPaths [pathA] [pathB] == Right [pathA,pathB] ||
    H.eitherPaths [pathA] [pathB] == Right [pathB,pathA]
  check chosen "K19 then preserves ordered owner-witnessed edges" $
    H.thenPaths [stageA] [stageB] == Right [pathA]
  check chosen "K20 missing coverage forbids unique predecessor" $
    H.predecessors False "closed" [pathA] == Right H.Unestablished
  check chosen "K21 complete one-path case remains conditional and non-authoritative" $
    H.predecessors True "closed" [pathA] == Right (H.ConditionalUnique pathA)
  check chosen "K22 discontinuity cannot become invented history" $
    H.admitPath (H.Path "planned" "closed" [H.Edge "gap" "MES" "planned" "lost" "unknown" "proof-1"]) == Left "terminal-mismatch"
  check chosen "K23 unapproved binding grade cannot gain semantic meaning" $
    compile example{binding=bindingFixture{mappingGrade="matched-by-name"}} ==
      Left "unapproved-cross-source-binding"
  let semantic = S.buildSemanticPackage example
      findFact fid p = case [f | f <- S.semanticFacts p,S.semanticFactId f == fid] of
        [f] -> Just f
        _ -> Nothing
      findReceipt cid p = case [r | r <- S.semanticReceipts p,S.receiptConstraintId r == cid] of
        [r] -> Just r
        _ -> Nothing
  check chosen "K24 typed reported fact retains exact source evidence" $
    case semantic >>= maybe (Left "missing") Right . findFact "fact:erp-reported-quantity" of
      Right f -> S.semanticPropertyId f == "reported-quantity" &&
        S.semanticKnowledge f == S.Known (S.QuantityValue "1.25" "synthetic-count") &&
        case S.semanticEvidence f of
          [e] -> S.evidenceRole e == "erp" && S.evidenceRevision e == "rev-77" &&
                 S.evidenceQueryDigest e == T.replicate 64 "a"
          _ -> False
      _ -> False
  check chosen "K25 physical production remains explicitly unknown" $
    case semantic >>= maybe (Left "missing") Right . findFact "fact:physical-production" of
      Right f -> S.semanticKnowledge f == S.Unknown "not-covered-by-admitted-native-read"
      _ -> False
  check chosen "K26 closed constraints distinguish satisfied violated and unknown" $
    case semantic of
      Right p ->
        fmap S.receiptStatus (findReceipt "constraint:plan-alignment" p) == Just S.Satisfied &&
        fmap S.receiptStatus (findReceipt "constraint:reported-alignment" p) == Just S.Violated &&
        fmap S.receiptStatus (findReceipt "constraint:physical-production-known" p) == Just S.Violated
      _ -> False
  let conflictEvidence = S.EvidenceBinding "evidence:test" "erp" "plantA" "W-75" "r" (T.replicate 64 "c")
      conflictFact = S.SemanticFact "left" "subject" "reported-quantity"
        (S.Conflicting [S.ConflictObservation (S.QuantityValue "1.0" "synthetic-count") conflictEvidence]) [conflictEvidence]
      knownFact = S.SemanticFact "right" "subject" "reported-quantity"
        (S.Known (S.QuantityValue "1.0" "synthetic-count")) [conflictEvidence]
  check chosen "K27 conflicting knowledge makes equality indeterminate" $
    S.receiptStatus (S.evaluateConstraint [conflictFact,knownFact] (S.SameValue "c" "left" "right")) == S.Indeterminate
  check chosen "K28 mapping fidelity stays bounded projection-only" $
    case semantic of
      Right p -> S.semanticMappingId (S.semanticMapping p) == "fde.w1.synthetic-pcs-Nos/v1" &&
        case S.semanticMappingFidelity (S.semanticMapping p) of
          S.ProjectionOnly reason -> T.isInfixOf "does not make ERP and MES schemas" reason
      _ -> False
  check chosen "K29 physical-production claim receives related not support" $
    case S.assessClaim example S.PhysicalProductionOccurred of
      Right a -> map S.claimRelation (S.assessedRelations a) == [S.Related,S.Related,S.Irrelevant]
      _ -> False
  check chosen "K30 exact reported quantity supports and mismatch contradicts" $
    case (S.assessClaim example (S.ReportedQuantity "erp" "1.250000"),
          S.assessClaim example (S.ReportedQuantity "erp" "2.0")) of
      (Right goodClaim,Right badClaim) ->
        map S.claimRelation (S.assessedRelations goodClaim) == [S.Supports,S.Irrelevant,S.Irrelevant] &&
        map S.claimRelation (S.assessedRelations badClaim) == [S.Contradicts,S.Irrelevant,S.Irrelevant]
      _ -> False
  check chosen "K31 reference evidence never substitutes for exact native support" $
    case S.assessClaim example S.NativeReportedValues of
      Right a -> map S.claimRelation (S.assessedRelations a) == [S.Supports,S.Supports,S.Irrelevant]
      _ -> False
  putStrLn "FDE Haskell semantics: all independent law tests passed."