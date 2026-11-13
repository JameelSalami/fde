{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE RecordWildCards #-}
-- Bounded JSON wire codec; Haskell Kernel owns the semantic laws.
module FDE.Wire (parseInput,renderDecision) where
import Control.Monad (unless)
import Data.Aeson (Value(..), object, withObject, (.:), (.=))
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import Data.Aeson.Types (Parser, parseEither)
import Data.List (sort)
import Data.Text (Text)
import qualified Data.Text as T
import FDE.Kernel (Source(..),Binding(..),CompileInput(..),Decision(..))

exact :: [Text] -> KM.KeyMap Value -> Parser ()
exact names obj = unless
  (sort (map Key.toText (KM.keys obj)) == sort names)
  (fail "closed-source-schema")

named :: Value -> Parser (Text, Text)
named = withObject "binding endpoint" $ \o -> do
  exact ["instance","nativeId"] o
  (,) <$> o .: "instance" <*> o .: "nativeId"

parseSource :: Text -> Value -> Parser Source
parseSource expected = withObject "native source" $ \o -> do
  exact ["schema","dataClass","role","vendor","instance","nativeId","businessId",
         "revision","nativeState","planned","reported","unit","coverage","capture"] o
  schema <- o .: "schema"
  unless (schema == ("fde.native-observation/v1" :: Text)) (fail "native-source-schema")
  sourceClass <- o .: "dataClass"
  role <- o .: "role"
  vendor <- o .: "vendor"
  instanceId <- o .: "instance"
  nativeId <- o .: "nativeId"
  businessId <- o .: "businessId"
  revision <- o .: "revision"
  nativeState <- o .: "nativeState"
  planned <- o .: "planned"
  reported <- o .: "reported"
  unit <- o .: "unit"
  unless (role == expected) (fail "wrong-source-role")
  let idOk x = not (T.null x) && T.length x <= 160 &&
        T.all (\c -> (c >= 'A' && c <= 'Z') ||
                     (c >= 'a' && c <= 'z') ||
                     (c >= '0' && c <= '9') || elem c (".:_/-" :: String)) x
  unless (all idOk [instanceId,nativeId,businessId] &&
          not (T.null revision) && T.length revision <= 256 &&
          not (T.null nativeState) && T.length nativeState <= 100)
    (fail "bad-source-identity")
  withObject "source coverage" (\c -> do
    exact ["order","receipt","ledger","physical"] c
    order <- c .: "order"
    receipt <- c .: "receipt"
    ledger <- c .: "ledger"
    physical <- c .: "physical"
    unless (order == ("exact-native-row" :: Text) &&
            receipt == ("not-covered" :: Text) &&
            ledger == ("not-covered" :: Text) &&
            physical == ("not-covered" :: Text))
      (fail "unqualified-coverage")) =<< o .: "coverage"
  (observedAt,queryDigest) <- withObject "source capture" (\c -> do
    exact ["observedAt","querySha256","mode","transport"] c
    at <- c .: "observedAt"
    q <- c .: "querySha256"
    mode <- c .: "mode"
    transport <- c .: "transport"
    unless (T.length (q :: Text) == 64 &&
            T.all (\x -> elem x ("0123456789abcdef" :: String)) q &&
            T.length (at :: Text) >= 20 && T.length at <= 40 &&
            ((sourceClass == ("handwritten-fixture" :: Text) &&
              mode == ("fixture" :: Text) && transport == ("not-applicable" :: Text)) ||
             (sourceClass == "isolated-synthetic-native" &&
              mode == "source-read-only" && transport == "TLSv1.3")))
      (fail "unqualified-capture")
    pure (at,q)) =<< o .: "capture"
  pure Source{..}

parseBinding :: Value -> Parser Binding
parseBinding = withObject "synthetic binding" $ \o -> do
  exact ["schema","grade","erp","mes","unit"] o
  schema <- o .: "schema"
  mappingGrade <- o .: "grade"
  unitPolicy <- o .: "unit"
  unless (schema == ("fde.native-binding/v1" :: Text))
    (fail "unrecognized-binding-envelope")
  (erpInstance,erpNativeId) <- named =<< o .: "erp"
  (mesInstance,mesNativeId) <- named =<< o .: "mes"
  pure Binding{..}

parseInput :: Value -> Either Text CompileInput
parseInput value = case parseEither parser value of
  Left _ -> Left "invalid-compile-envelope"
  Right v -> Right v
  where
    parser = withObject "FDE compile input" $ \o -> do
      exact ["schema","erp","mes","binding"] o
      schema <- o .: "schema"
      unless (schema == ("fde.case/v1" :: Text)) (fail "unknown-schema")
      erp <- parseSource "erp" =<< o .: "erp"
      mes <- parseSource "mes" =<< o .: "mes"
      binding <- parseBinding =<< o .: "binding"
      pure CompileInput{..}

candidate :: Text -> Source -> Text -> Text -> Value
candidate kind src property qty = object
  [ "family" .= (if kind == "work-plan" then ("WorkPlan" :: Text) else "SourceReport")
  , "rootKind" .= (if kind == "work-plan" then ("WorkRequest" :: Text) else "QuantityReport")
  , "sourceVendor" .= vendor src
  , "sourceInstance" .= instanceId src
  , "sourceNativeId" .= nativeId src
  , "sourceBusinessId" .= businessId src
  , "sourceRevision" .= revision src
  , "sourceQueryDigest" .= queryDigest src
  , "property" .= property
  , "quantity" .= qty
  , "unit" .= unit src
  , "status" .= nativeState src
  , "authority" .= ("none" :: Text)
  ]

renderDecision :: Decision -> Value
renderDecision Decision{..} =
  let a = erp input
      b = mes input
  in object
    [ "schema" .= ("fde.compiled-diagnostic/v1" :: Text)
    , "authority" .= ("none" :: Text)
    , "businessTruthSelected" .= False
    , "admissionStatus" .= ("candidate-only" :: Text)
    , "classification" .= classification
    , "plannedDelta" .= plannedDelta
    , "reportedDelta" .= reportedDelta
    , "humanReviewRequired" .= needsReview
    , "sourceClass" .= (if sourceClass a == "isolated-synthetic-native" &&
         sourceClass b == "isolated-synthetic-native"
         then ("isolated-synthetic-native" :: Text)
         else "handwritten-fixture")
    , "candidates" .=
      [ candidate "work-plan" a "requested-quantity" (planned a)
      , candidate "work-plan" b "requested-quantity" (planned b)
      , candidate "report" a "recorded-manufacturing-quantity" (reported a)
      , candidate "report" b "reported-execution-quantity" (reported b)
      ]
    , "bindingGrade" .= mappingGrade (binding input)
    , "erpNativeId" .= nativeId a
    , "mesNativeId" .= nativeId b
    , "erpRevision" .= revision a
    , "mesRevision" .= revision b
    , "erpQueryDigest" .= queryDigest a
    , "mesQueryDigest" .= queryDigest b
    , "receiptCoverage" .= ("not-covered" :: Text)
    , "ledgerCoverage" .= ("not-covered" :: Text)
    , "physicalCoverage" .= ("not-covered" :: Text)
    , "atomicSnapshot" .= False
    , "postingPermitted" .= False
    , "physicalProductionCertified" .= False
    , "mutationCandidate" .= object
      [ "kind" .= ("human-discrepancy-review" :: Text)
      , "targetSystem" .= ("none" :: Text)
      , "evidenceRequired" .= True
      , "executable" .= False
      ]
    ]