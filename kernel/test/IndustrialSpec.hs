{-# LANGUAGE OverloadedStrings #-}
module Main (main) where
import Control.Monad (when)
import Data.Aeson (Value(..),object,(.=),encode)
import qualified Data.ByteString.Lazy as Bytes
import qualified Data.Aeson.KeyMap as KM
import Data.List (find)
import Data.Ratio ((%))
import Data.Text (Text)
import qualified Data.Text as T
import System.Environment (getArgs)
import System.Exit (exitFailure)
import FDE.Industrial
import FDE.IndustrialWire (parseIndustrial,processIndustrial,renderAssessment)

check :: [String] -> String -> Bool -> IO ()
check selected name ok = when (null selected || takeWhile (/=' ') name `elem` selected) $
  if ok then putStrLn ("PASS "<>name) else putStrLn ("FAIL "<>name) >> exitFailure

category :: Investigation -> Either Text Text
category input = classification <$> assess input
value :: Text -> Investigation -> Maybe Rational
value name input = either (const Nothing) (fmap metricValue . find ((==name) . metricId) . metrics) (assess input)
hasFinding :: Text -> FindingStatus -> Investigation -> Bool
hasFinding code status input = either (const False)
  (any (\f -> findingCode f==code && findingStatus f==status) . findings) (assess input)

pdm :: PdmInput
pdm = PdmInput "P-17" "plant-A/variant-red" (Just "B") (Just "B")
  "confirmed" "released" "applicable" False False Nothing
  (Just "3.125") (Just "3.125000") (Just "piece") (Just "piece") ["e-pdm"]
obs :: Observation
obs = Observation ["60","120"] "s" "part-P17/shift-1" "stopwatch-v2"
  "operator-observation" "same-tool-and-staffing" "baseline-2026-09" "adequate"
proc :: ProcessInput
proc = ProcessInput "cycle" obs (obs{samples=["1","1"],observationUnit="min",observationWindow="followup-2026-10"}) ["e-time"]
mechanical :: MechanicalInput
mechanical = MechanicalInput "tooling" ["req"] ["drawing-r2"] ["inspection"] ["site-check"]
  (Just "quality-owner") "accepted" ["signed-review"] ["req","drawing-r2","inspection","site-check","signed-review"]
worker :: WorkerInput
worker = WorkerInput "USD" [MoneyItem "cash-material" "100.00" "cash-basis"] [MoneyItem "cost-fixture" "20" "cost-basis"]
  "nonoverlapping" (Just "12.5") (Just "Less repetitive handling") "observed"
  (Just "25") "authorized" (Just "20") ["pay-record"] ["observation","pay-record","cash-basis","cost-basis"]
triage :: TriageInput
triage = TriageInput "reporting-discrepancy"
  ["native-records","field-definitions","identity-binding","observation-window"] True False
lineA,lineB :: BomLine
lineA = BomLine "10" "P-1" "A" "2" "piece" "ebom"
lineB = BomLine "20" "P-2" "B" "1" "piece" "ebom"
bom :: BomInput
bom = BomInput "ASSEMBLY-1" "plant-A" (Just "R1") (Just "R1") "released" "applicable"
  [lineA,lineB] [lineA,lineB] [] Nothing Nothing [] ["ebom","mbom","approval","uses"]
approvedSub :: Substitution
approvedSub = Substitution "10" "P-1" "A" "P-ALT" "Z" "2" "approval"
usageA,usageB :: WhereUsed
usageA = WhereUsed "SUB" "1" "P-1" "A" "plant-A" "uses"
usageB = WhereUsed "TOP" "2" "SUB" "1" "plant-A" "uses"

main :: IO ()
main = do
  selected <- getArgs
  check selected "I01 finite triage catalog routes all eight concerns and refuses unknown" $
    map catalogId industrialCatalog == ["reporting","pdm-bom","flow-setup","quality-measurement","tooling","layout","maintenance","reporting-signage"] &&
    all (either (const False) (not . null . nextInvestigations) . assess . Triage . (\c -> triage{concern=c}))
      ["reporting-discrepancy","pdm-bom","flow-setup","quality-measurement","tooling","layout","maintenance","reporting-signage"] &&
    assess (Triage triage{concern="unknown"}) == Left "unsupported-investigation-concern"
  check selected "I02 measurement readiness changes investigation sequence" $
    category (Triage triage{concern="flow-setup",measurementReady=False}) == Right "measurement-first" &&
    category (Triage triage{concern="flow-setup",measurementReady=True}) == Right "evidence-needed"
  check selected "I03 worker concern requires worker observation" $
    category (Triage triage) == Right "investigation-ready" &&
    hasFinding "missing:worker-observation" Unresolved (Triage triage{workerConcern=True})
  check selected "I04 PDM effectivity cannot be inferred from revision equality" $
    category (Pdm pdm) == Right "applicable-definition-consistent" &&
    category (Pdm pdm{effectivity="unknown"}) == Right "effectivity-unresolved" &&
    category (Pdm pdm{effectivity="not-applicable"}) == Right "definition-not-applicable"
  check selected "I05 conflicting identity prevents a consistent PDM result" $
    category (Pdm pdm) == Right "applicable-definition-consistent" &&
    category (Pdm pdm{identity="conflicting"}) == Right "conflicting-identity" &&
    value "manufacturing-minus-engineering-quantity" (Pdm pdm{identity="unknown"}) == Nothing
  check selected "I06 draft release does not count as released" $
    hasFinding "release-state" Supported (Pdm pdm) &&
    category (Pdm pdm{release="draft"}) == Right "release-unresolved"
  check selected "I07 approved change needs propagation evidence" $
    category (Pdm pdm{changeApproved=True,changePropagated=Just True}) == Right "applicable-definition-consistent" &&
    category (Pdm pdm{changeApproved=True,changePropagated=Just False}) == Right "change-not-propagated" &&
    category (Pdm pdm{changeApproved=True,changePropagated=Nothing}) == Right "change-propagation-unresolved"
  check selected "I08 older applicable revision and recorded alternate have distinct meaning" $
    category (Pdm pdm{requiredRevision=Just "A",observedRevision=Just "A"}) == Right "applicable-definition-consistent" &&
    category (Pdm pdm{observedRevision=Just "ALT",approvedAlternate=True}) == Right "approved-alternate-recorded" &&
    category (Pdm pdm{observedRevision=Just "A"}) == Right "revision-mismatch"
  check selected "I09 BOM exact quantities require matching explicit units" $
    value "manufacturing-minus-engineering-quantity" (Pdm pdm{manufacturingQuantity=Just "5.875"}) == Just (11%4) &&
    category (Pdm pdm{manufacturingQuantity=Just "5.875"}) == Right "bom-quantity-mismatch" &&
    category (Pdm pdm{manufacturingUnit=Just "box"}) == Right "unit-mapping-unresolved" &&
    value "manufacturing-minus-engineering-quantity" (Pdm pdm{manufacturingUnit=Just "box"}) == Nothing
  check selected "I10 PDM missing evidence stays incomplete" $
    category (Pdm pdm) == Right "applicable-definition-consistent" &&
    category (Pdm pdm{pdmEvidence=[]}) == Right "evidence-incomplete" &&
    value "manufacturing-minus-engineering-quantity" (Pdm pdm{pdmEvidence=[]}) == Nothing &&
    category (Pdm pdm{requiredRevision=Nothing}) == Right "evidence-incomplete" &&
    category (Pdm pdm{requiredRevision=Just "",observedRevision=Just ""}) == Right "evidence-incomplete"
  let thirds = proc{baseline=obs{samples=["1","0","0"]},followup=obs{samples=["0","0","0"]}}
  check selected "I11 descriptive means preserve nonterminating exact ratios" $
    value "baseline-mean" (Process thirds) == Just (1%3) &&
    value "baseline-mean" (Process thirds{baseline=obs{samples=[]}}) == Nothing
  check selected "I12 time conversion makes seconds and minutes comparable" $
    value "baseline-mean" (Process proc) == Just 90 &&
    value "followup-mean" (Process proc) == Just 60 &&
    value "baseline-minus-followup" (Process proc) == Just 30 &&
    category (Process proc{followup=(followup proc){observationUnit="percent"}}) == Right "incompatible-measure-unit"
  check selected "I13 different populations cannot silently become improvement" $
    category (Process proc) == Right "descriptive-comparison" &&
    category (Process proc{followup=(followup proc){population="different-product-mix"}}) == Right "comparison-not-established" &&
    value "baseline-minus-followup" (Process proc{followup=(followup proc){conditions="new-staffing"}}) == Nothing
  check selected "I14 order elapsed time is not operator cycle time" $
    category (Process proc) == Right "descriptive-comparison" &&
    category (Process proc{baseline=obs{basis="order-elapsed"}}) == Right "measurement-basis-invalid"
  let qualityObs = obs{samples=["2","4"],observationUnit="percent",basis="inspection"}
      quality = ProcessInput "defect-rate" qualityObs qualityObs{samples=["1","1"]} ["inspection-batch"]
  check selected "I15 quality rates need valid percentages and inspection observations" $
    value "baseline-minus-followup" (Process quality) == Just 2 &&
    assess (Process quality{baseline=qualityObs{samples=["101"]}}) == Left "quality-percentage-out-of-range" &&
    category (Process quality{baseline=qualityObs{basis="operator-observation"}}) == Right "measurement-basis-invalid"
  check selected "I16 unknown measurement quality prevents performance comparison" $
    category (Process proc) == Right "descriptive-comparison" &&
    category (Process proc{baseline=obs{measurementQuality="unknown"}}) == Right "measurement-quality-unresolved"
  let zero = proc{baseline=obs{samples=["0","0"]},followup=obs{samples=["0","0"]}}
  check selected "I17 zero baseline never creates a percentage change" $
    value "relative-reduction-percent" (Process proc) == Just (100%3) &&
    value "relative-reduction-percent" (Process zero) == Nothing &&
    hasFinding "zero-baseline" Unresolved (Process zero)
  check selected "I18 exact decimal admission refuses significant excess precision" $
    value "baseline-mean" (Process proc{baseline=obs{samples=["0.000001000"]}}) == Just (1%1000000) &&
    assess (Process proc{baseline=obs{samples=["0.0000001"]}}) == Left "invalid-exact-decimal"
  check selected "I19 local mechanical evidence remains required for recorded acceptance" $
    category (Mechanical mechanical) == Right "acceptance-recorded" &&
    category (Mechanical mechanical{localObservations=[]}) == Right "local-verification-pending"
  check selected "I20 mechanical acceptance needs a reviewer and separate acceptance evidence" $
    category (Mechanical mechanical) == Right "acceptance-recorded" &&
    category (Mechanical mechanical{reviewer=Nothing}) == Right "review-pending" &&
    category (Mechanical mechanical{acceptanceEvidence=[]}) == Right "review-pending" &&
    category (Mechanical mechanical{acceptance="rejected"}) == Right "acceptance-rejected"
  check selected "I21 mechanical references must bind to supplied evidence identifiers" $
    category (Mechanical mechanical) == Right "acceptance-recorded" &&
    assess (Mechanical mechanical{measurements=["invented-measurement"]}) == Left "unbound-mechanical-evidence"
  check selected "I22 worker cash allocation uses net cash and keeps capacity separate" $
    value "net-observed-cash" (WorkerBenefit worker) == Just 80 &&
    value "authorized-allocation" (WorkerBenefit worker) == Just 20 &&
    value "released-capacity" (WorkerBenefit worker) == Just (25%2) &&
    value "authorized-allocation" (WorkerBenefit worker{cashItems=[]}) == Nothing
  check selected "I23 financial commitment cannot be inferred from an opportunity" $
    value "authorized-allocation" (WorkerBenefit worker) == Just 20 &&
    value "authorized-allocation" (WorkerBenefit worker{commitment="uncommitted"}) == Nothing &&
    category (WorkerBenefit worker{commitment="uncommitted"}) == Right "financial-distribution-uncommitted"
  check selected "I24 delivery requires its own evidence and preserves shortfalls" $
    category (WorkerBenefit worker) == Right "delivery-evidence-recorded" &&
    category (WorkerBenefit worker{deliveryEvidence=[]}) == Right "delivery-unverified" &&
    value "recorded-delivery" (WorkerBenefit worker{deliveryEvidence=[]}) == Nothing &&
    assess (WorkerBenefit worker{deliveryEvidence=["invented-payment"]}) == Left "unbound-worker-evidence" &&
    category (WorkerBenefit worker{deliveredAmount=Just "5"}) == Right "delivery-partial" &&
    value "remaining-allocation" (WorkerBenefit worker{deliveredAmount=Just "5"}) == Just 15
  check selected "I25 duplicate cash and cost identifiers are refused" $
    value "net-observed-cash" (WorkerBenefit worker) == Just 80 &&
    assess (WorkerBenefit worker{costItems=[MoneyItem "cash-material" "20" "cost-basis"]}) == Left "duplicate-benefit-entry"
  check selected "I26 negative net cash cannot generate a positive worker allocation" $
    value "authorized-allocation" (WorkerBenefit worker) == Just 20 &&
    value "net-observed-cash" (WorkerBenefit worker{costItems=[MoneyItem "cost-fixture" "120" "cost-basis"]}) == Just (-20) &&
    value "authorized-allocation" (WorkerBenefit worker{costItems=[MoneyItem "cost-fixture" "120" "cost-basis"]}) == Just 0
  check selected "I27 unverified overlapping cash basis prevents allocation" $
    value "authorized-allocation" (WorkerBenefit worker) == Just 20 &&
    value "authorized-allocation" (WorkerBenefit worker{cashScope="unverified"}) == Nothing
  check selected "I28 unobserved and disputed worker outcomes remain distinct" $
    category (WorkerBenefit worker) == Right "delivery-evidence-recorded" &&
    category (WorkerBenefit worker{workerObservation="unobserved"}) == Right "outcome-unobserved" &&
    category (WorkerBenefit worker{workerObservation="disputed"}) == Right "outcome-disputed" &&
    value "net-observed-cash" (WorkerBenefit worker{workerObservation="unobserved"}) == Nothing
  check selected "I29 nonfinancial benefit can be observed without financial commitment" $
    hasFinding "nonfinancial-outcome" Supported (WorkerBenefit worker{commitment="uncommitted"}) &&
    hasFinding "nonfinancial-outcome" Unresolved (WorkerBenefit worker{workerObservation="unobserved"})
  let envelope = object ["schema" .= ("fde.industrial-assessment-request/v1"::Text)
        ,"investigation" .= object ["kind" .= ("triage"::Text),"concern" .= ("reporting-discrepancy"::Text)
          ,"availableEvidence" .= ([]::[Text]),"measurementReady" .= False,"workerConcern" .= True]]
  let catalogEnvelope = object ["schema" .= ("fde.industrial-catalog-request/v1"::Text)]
  check selected "I30 industrial wire refuses unknown fields" $
    either (const False) (const True) (processIndustrial catalogEnvelope) &&
    processIndustrial (object ["schema" .= ("fde.industrial-catalog-request/v1"::Text),"injected" .= True]) == Left "invalid-industrial-request" &&
    either (const False) (const True) (parseIndustrial envelope) &&
    case envelope of
      Object o -> parseIndustrial (Object (KM.insert "forgedAuthority" (Bool True) o)) == Left "invalid-industrial-request"
      _ -> False
  check selected "I31 every assessment keeps operational and physical authority false" $
    all (\input -> case renderAssessment <$> assess input of
      Right (Object o) -> KM.lookup "authority" o == Just (String "none") &&
        KM.lookup "vendorWriteAllowed" o == Just (Bool False) &&
        KM.lookup "physicalAcceptanceCertified" o == Just (Bool False)
      _ -> False) [Triage triage,Pdm pdm,Process proc,Mechanical mechanical,WorkerBenefit worker,Bom bom] &&
    category (Mechanical mechanical{acceptance="pending"}) == Right "review-pending"
  check selected "I32 allocation percentages are bounded and exact" $
    value "authorized-allocation" (WorkerBenefit worker{allocationPercent=Just "12.5"}) == Just 10 &&
    assess (WorkerBenefit worker{allocationPercent=Just "100.000001"}) == Left "allocation-percent-out-of-range"
  check selected "I33 mechanical definition requires requirements drawings and measurements" $
    category (Mechanical mechanical) == Right "acceptance-recorded" &&
    category (Mechanical mechanical{measurements=[]}) == Right "evidence-incomplete"
  check selected "I34 process samples require traceable context and evidence" $
    category (Process proc) == Right "descriptive-comparison" &&
    category (Process proc{processEvidence=[]}) == Right "evidence-incomplete" &&
    category (Process proc{baseline=obs{observationWindow=""}}) == Right "evidence-incomplete"
  let catalogLaw code name allEvidence missing =
        check selected (code<>" "<>name<>" has its own evidence prerequisites") $
          category (Triage triage{concern=T.pack name,availableEvidence=allEvidence}) == Right "investigation-ready" &&
          hasFinding ("missing:"<>missing) Unresolved
            (Triage triage{concern=T.pack name,availableEvidence=filter (/=missing) allEvidence})
  catalogLaw "I35" "reporting-discrepancy"
    ["native-records","field-definitions","identity-binding","observation-window"] "native-records"
  catalogLaw "I36" "pdm-bom"
    ["part-identity","released-definition","effectivity","production-bom","point-of-use"] "point-of-use"
  catalogLaw "I37" "flow-setup"
    ["process-boundary","time-observations","product-mix","worker-observation"] "time-observations"
  catalogLaw "I38" "quality-measurement"
    ["requirement","measurement-method","inspection-observations","sampling-plan"] "measurement-method"
  catalogLaw "I39" "tooling"
    ["requirement","design-reference","measurement","local-observation"] "design-reference"
  catalogLaw "I40" "layout"
    ["layout-reference","dimensions","movement-observations","worker-observation"] "movement-observations"
  catalogLaw "I41" "maintenance"
    ["asset-identity","failure-history","maintenance-records","worker-observation"] "failure-history"
  catalogLaw "I42" "reporting-signage"
    ["decision-owner","metric-definition","source-lineage","freshness-requirement"] "freshness-requirement"
  let evidence = InventoryEvidence "e-pdm" "synthetic" "r1" "2026-10-31T12:00:00Z" "" "fixture:pdm-17"
      bound = assessCase (Pdm pdm) [evidence]
      boundCategory es = classification <$> assessCase (Pdm pdm) es
  check selected "I43 case assessment requires references in the saved inventory" $
    boundCategory [evidence] == Right "applicable-definition-consistent" &&
    boundCategory [] == Right "evidence-linkage-unresolved" &&
    either (const False) (null . metrics) (assessCase (Pdm pdm) []) &&
    either (const False) (all ((/=Supported) . findingStatus) . findings) (assessCase (Pdm pdm) [])
  check selected "I44 linked evidence needs revision observation and reference context" $
    boundCategory [evidence] == Right "applicable-definition-consistent" &&
    boundCategory [evidence{inventoryRevision=""}] == Right "evidence-context-incomplete" &&
    boundCategory [evidence{inventoryReference=""}] == Right "evidence-context-incomplete"
  check selected "I45 recorded evidence limitations cannot disappear during assessment" $
    boundCategory [evidence] == Right "applicable-definition-consistent" &&
    boundCategory [evidence{inventoryLimitations="Superseded copy; currentness unresolved"}] == Right "evidence-limited" &&
    either (const False) (null . metrics) (assessCase (Pdm pdm) [evidence{inventoryLimitations="Incomplete inspection scope"}])
  check selected "I46 case evidence identifiers must resolve uniquely" $
    either (const False) (const True) bound &&
    assessCase (Pdm pdm) [evidence,evidence] == Left "ambiguous-case-evidence"
  let inventoryJson origin = object ["id" .= ("context"::Text),"origin" .= (origin::Text)
        ,"revision" .= ("r1"::Text),"observedAt" .= ("2026-10-31T12:00:00Z"::Text)
        ,"limitations" .= (""::Text),"reference" .= ("fixture:context"::Text)]
      caseEnvelope origin = object ["schema" .= ("fde.industrial-case-assessment-request/v1"::Text)
        ,"request" .= envelope,"evidenceInventory" .= [inventoryJson origin]]
  check selected "I47 case inventory cannot forge host-acquired provenance" $
    either (const False) (const True) (processIndustrial (caseEnvelope "synthetic")) &&
    processIndustrial (caseEnvelope "host-pinned-w1") == Left "invalid-industrial-case-request"
  check selected "I48 multi-line BOM finds missing extra and unequal quantities" $
    category (Bom bom) == Right "bom-lines-consistent" &&
    hasFinding "missing-manufacturing-position:10" Contradicted (Bom bom{manufacturingLines=[lineB]}) &&
    hasFinding "extra-manufacturing-position:30" Contradicted (Bom bom{manufacturingLines=[lineA,lineB,BomLine "30" "EXTRA" "1" "1" "piece" "mbom"]}) &&
    value "quantity-delta:10" (Bom bom{manufacturingLines=[lineA{lineQuantity="3.125"},lineB]}) == Just (9%8)
  check selected "I49 BOM comparison does not equate different parts or revisions" $
    value "quantity-delta:10" (Bom bom) == Just 0 &&
    value "quantity-delta:10" (Bom bom{manufacturingLines=[lineA{lineRevision="B"},lineB]}) == Nothing &&
    hasFinding "part-at-position:10" Contradicted (Bom bom{manufacturingLines=[lineA{linePartId="OTHER"},lineB]})
  let alternate = bom{manufacturingLines=[lineA{linePartId="P-ALT",lineRevision="Z",lineQuantity="4"},lineB],substitutions=[approvedSub]}
  check selected "I50 approved BOM substitution uses its explicit quantity factor" $
    category (Bom alternate) == Right "bom-lines-consistent" &&
    value "quantity-delta:10" (Bom alternate) == Just 0 &&
    category (Bom alternate{substitutions=[]}) == Right "bom-lines-differ" &&
    value "quantity-delta:10" (Bom alternate{manufacturingLines=[lineA{linePartId="P-ALT",lineRevision="Z",lineQuantity="3"},lineB]}) == Just (-1)
  check selected "I51 BOM substitution cannot create a unit equivalence" $
    value "quantity-delta:10" (Bom bom) == Just 0 &&
    category (Bom bom{manufacturingLines=[lineA{lineUnit="box"},lineB]}) == Right "bom-comparison-unresolved" &&
    value "quantity-delta:10" (Bom bom{manufacturingLines=[lineA{lineUnit="box"},lineB]}) == Nothing
  check selected "I52 BOM position identities must be unique within each side" $
    category (Bom bom) == Right "bom-lines-consistent" &&
    assess (Bom bom{engineeringLines=[lineA,lineA]}) == Left "duplicate-bom-position"
  let used = bom{selectedPart=Just "P-1",selectedRevision=Just "A",whereUsed=[usageA,usageB]}
  check selected "I53 where-used traversal stays within the supplied configuration" $
    value "supplied-where-used-ancestor-count" (Bom used) == Just 2 &&
    value "supplied-where-used-ancestor-count" (Bom used{bomConfiguration="different-plant"}) == Just 0
  check selected "I54 where-used traversal respects component revision identity" $
    value "supplied-where-used-ancestor-count" (Bom used) == Just 2 &&
    value "supplied-where-used-ancestor-count" (Bom used{selectedRevision=Just "different-revision"}) == Just 0
  let cyclic = used{whereUsed=[usageA,WhereUsed "P-1" "A" "SUB" "1" "plant-A" "uses"]}
      diamond = used{whereUsed=[usageA,WhereUsed "SUB-2" "1" "P-1" "A" "plant-A" "uses",usageB,WhereUsed "TOP" "2" "SUB-2" "1" "plant-A" "uses"]}
  check selected "I55 where-used cycles terminate and shared ancestors are not cycles" $
    category (Bom cyclic) == Right "where-used-cycle" &&
    category (Bom diamond) == Right "bom-lines-consistent" &&
    value "supplied-where-used-ancestor-count" (Bom diamond) == Just 3
  check selected "I56 BOM context requires explicit applicable released assembly revision" $
    category (Bom bom) == Right "bom-lines-consistent" &&
    category (Bom bom{bomEffectivity="unknown"}) == Right "bom-applicability-unresolved" &&
    category (Bom bom{bomRelease="draft"}) == Right "bom-release-unresolved" &&
    category (Bom bom{assemblyObservedRevision=Just "R2"}) == Right "assembly-revision-mismatch" &&
    value "quantity-delta:10" (Bom bom{assemblyObservedRevision=Just "R2"}) == Nothing
  check selected "I57 each worker cash or cost item needs linked basis evidence" $
    value "authorized-allocation" (WorkerBenefit worker) == Just 20 &&
    assess (WorkerBenefit worker{cashItems=[MoneyItem "cash-material" "100" "unbound"]}) == Left "unbound-benefit-item-evidence"
  check selected "I58 distinct benefit IDs sharing one basis do not prove separate value" $
    value "authorized-allocation" (WorkerBenefit worker) == Just 20 &&
    value "authorized-allocation" (WorkerBenefit worker{costItems=[MoneyItem "cost-fixture" "20" "cash-basis"]}) == Nothing &&
    hasFinding "shared-benefit-basis" Unresolved (WorkerBenefit worker{costItems=[MoneyItem "cost-fixture" "20" "cash-basis"]})
  check selected "I59 BOM substitution needs linked approval and positive factor" $
    category (Bom alternate) == Right "bom-lines-consistent" &&
    assess (Bom alternate{substitutions=[approvedSub{approvalRef="unbound"}]}) == Left "unbound-substitution-evidence" &&
    assess (Bom alternate{substitutions=[approvedSub{quantityFactor="0"}]}) == Left "invalid-substitution-factor" &&
    assess (Bom alternate{substitutions=[approvedSub,approvedSub]}) == Left "ambiguous-substitution"
  check selected "I60 where-used records need distinct relationships and linked evidence" $
    value "supplied-where-used-ancestor-count" (Bom used) == Just 2 &&
    assess (Bom used{whereUsed=[usageA,usageA]}) == Left "duplicate-where-used-relationship" &&
    assess (Bom used{whereUsed=[usageA{usageEvidence="unbound"}]}) == Left "unbound-where-used-evidence"
  check selected "I61 BOM line evidence must bind to the supplied source inventory" $
    category (Bom bom) == Right "bom-lines-consistent" &&
    assess (Bom bom{engineeringLines=[lineA{lineEvidenceRef="unbound"},lineB]}) == Left "unbound-bom-line-evidence"
  let number n = T.pack (show (n::Int))
      wideEngineering = [BomLine (number n) ("P-"<>number n) "A" "2" "piece" "ebom" | n <- [1..128]]
      wideManufacturing = [row{lineRevision="B",lineUnit="box",lineEvidenceRef="mbom"} | row <- wideEngineering]
      wideUsage = [WhereUsed ("ASSEMBLY-"<>number n) "1" (if n==1 then "LEAF" else "ASSEMBLY-"<>number (n-1)) "1" "plant-A" "uses" | n <- [1..128]]
      wide = bom{engineeringLines=wideEngineering,manufacturingLines=wideManufacturing,whereUsed=wideUsage,selectedPart=Just "LEAF",selectedRevision=Just "1"}
  check selected "I62 supported128-row BOM emits complete bounded findings without truncation" $
    case assess (Bom wide) of
      Left _ -> False
      Right a -> length (findings a)==642 && all ((<=2) . length . findingEvidence) (findings a) &&
        value "supplied-where-used-ancestor-count" (Bom wide)==Just 128 &&
        Bytes.length (encode (renderAssessment a)) < 2*1024*1024
  let separated = used{whereUsed=[usageA{parentId="a:b",parentRevision="c"},usageA{parentId="a",parentRevision="b:c"}]}
  check selected "I63 compound where-used identifiers preserve distinct part revision pairs" $
    hasFinding "where-used:3:a:b:1:c" Supported (Bom separated) &&
    hasFinding "where-used:1:a:3:b:c" Supported (Bom separated) &&
    case assess (Bom separated) of
      Left _ -> False
      Right a -> let codes=map findingCode (findings a) in length codes==length (uniqueCodes codes)
  check selected "I64 semantic reference identifiers refuse control characters" $
    category (Pdm pdm) == Right "applicable-definition-consistent" &&
    assess (Pdm pdm{pdmEvidence=["bad\nref"]}) == Left "invalid-pdm-evidence" &&
    assess (Bom bom{engineeringLines=[lineA{linePartId="bad\npart"},lineB]}) == Left "incomplete-bom-line"
  putStrLn "FDE industrial semantics: selected independent assertions passed."
  where uniqueCodes []=[]
        uniqueCodes (x:xs)=x:uniqueCodes (filter (/=x) xs)
