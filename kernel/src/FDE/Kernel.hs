{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE RecordWildCards #-}
-- Pure handwritten FDE meaning; no JSON, SQL, clock, UI or effect.
module FDE.Kernel
  (Source(..),Binding(..),CompileInput(..),Decision(..),compile,canonicalQuantity)
where
import Data.Char (ord)
import Data.Text (Text)
import qualified Data.Text as T

data Source = Source
  { role :: Text, vendor :: Text, instanceId :: Text, nativeId :: Text
  , businessId :: Text, revision :: Text, nativeState :: Text
  , planned :: Text, reported :: Text, unit :: Text, sourceClass :: Text
  , observedAt :: Text, queryDigest :: Text
  } deriving (Eq, Show)

data Binding = Binding
  { erpInstance :: Text, erpNativeId :: Text
  , mesInstance :: Text, mesNativeId :: Text
  , mappingGrade :: Text, unitPolicy :: Text
  } deriving (Eq, Show)

data CompileInput = CompileInput
  { erp :: Source, mes :: Source, binding :: Binding
  } deriving (Eq, Show)

data Decision = Decision
  { input :: CompileInput, classification :: Text
  , plannedDelta :: Text, reportedDelta :: Text, needsReview :: Bool
  } deriving (Eq, Show)

-- | Exact decimal micro-units, allowing extra native *zero-only* precision.
quantity :: Text -> Either Text Integer
quantity value =
  let parts = T.splitOn "." value
      asciiDigit c = c >= '0' && c <= '9'
      canonicalWhole w = not (T.null w) && T.length w <= 15 &&
        T.all asciiDigit w && (w == "0" || T.head w /= '0')
      digits = T.foldl' (\n c -> n * 10 + toInteger (ord c - ord '0')) 0
  in case parts of
    [w] | canonicalWhole w -> Right (digits w * 1000000)
    [w,f] | canonicalWhole w && not (T.null f) && T.length f <= 12 &&
            T.all asciiDigit f && T.all (== '0') (T.drop 6 f) ->
              Right (digits w * 1000000 + digits (T.take 6 (f <> T.replicate 6 "0")))
    _ -> Left "invalid-exact-decimal"

canonicalQuantity :: Text -> Either Text Text
canonicalQuantity value = decimal <$> quantity value

decimal :: Integer -> Text
decimal n =
  let p = abs n
      whole = T.pack (show (div p 1000000))
      padded = T.pack (show (mod p 1000000))
      suffix = T.replicate (6 - T.length padded) "0" <> padded
      meaningful = T.dropWhileEnd (== '0') suffix
  in (if n < 0 then "-" else "") <> whole <> "." <>
      (if T.null meaningful then "0" else meaningful)

compile :: CompileInput -> Either Text Decision
compile input@CompileInput{..}
  | role erp /= "erp" || vendor erp /= "erpnext" || unit erp /= "Nos" ||
    role mes /= "mes" || vendor mes /= "openmes" || unit mes /= "pcs" =
      Left "wrong-native-source"
  | mappingGrade binding /= "synthetic-native-import-reviewed" ||
    unitPolicy binding /= "synthetic-pcs-equals-Nos" =
      Left "unapproved-cross-source-binding"
  | erpInstance binding /= instanceId erp ||
    erpNativeId binding /= nativeId erp ||
    mesInstance binding /= instanceId mes ||
    mesNativeId binding /= nativeId mes = Left "unbound-native-identity"
  | otherwise = do
      ep <- quantity (planned erp)
      mp <- quantity (planned mes)
      er <- quantity (reported erp)
      mr <- quantity (reported mes)
      let dp = mp - ep
          dr = mr - er
          known = elem (nativeState erp) ["Not Started","In Process","Completed","Stopped"] &&
                  elem (nativeState mes) ["PENDING","IN_PROGRESS","DONE","CANCELLED"]
          category
            | not known = "indeterminate-native-state"
            | dp /= 0 && dr /= 0 = "plan-and-report-disagreement"
            | dp /= 0 = "plan-disagreement"
            | dr /= 0 = "reported-gap"
            | otherwise = "aligned-reports"
      pure Decision { input=input, classification=category
        , plannedDelta=decimal dp, reportedDelta=decimal dr
        , needsReview=category /= "aligned-reports" }
