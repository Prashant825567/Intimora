import React, { useState } from "react";
import { Shield, AlertTriangle } from "lucide-react";

interface AgeGateProps {
  onConfirm: () => void;
}

const AgeGate: React.FC<AgeGateProps> = ({ onConfirm }) => {
  const [declined, setDeclined] = useState(false);

  if (declined) {
    return (
      <div className="mobile-overlay fixed inset-0 bg-black flex items-center justify-center z-[9999]">
        <div className="mobile-overlay__content text-center px-6">
          <AlertTriangle className="w-16 h-16 text-red-500 mx-auto mb-4" />
          <h2 className="text-2xl font-bold text-white mb-2">Access Denied</h2>
          <p className="text-gray-400">You must be 18 or older to access this site.</p>
          <button
            onClick={() => setDeclined(false)}
            className="mt-6 px-6 py-2 bg-gold-600 text-white rounded-lg hover:bg-yellow-600 transition"
          >
            Go Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mobile-overlay fixed inset-0 z-[9999] flex items-center justify-center bg-black">
      {/* Background blur texture */}
      <div
        className="absolute inset-0 opacity-10"
        style={{
          backgroundImage:
            "radial-gradient(circle at 20% 50%, #c9a84c 0%, transparent 50%), radial-gradient(circle at 80% 20%, #c9a84c 0%, transparent 40%)",
        }}
      />

      <div className="mobile-overlay__content age-gate__panel relative z-10 max-w-md w-full mx-4">
        {/* Card */}
        <div
          className="age-gate__card rounded-2xl p-8 text-center border border-yellow-800/40"
          style={{
            background: "linear-gradient(145deg, #111111, #0a0a0a)",
            boxShadow: "0 0 60px rgba(201,168,76,0.15), 0 0 0 1px rgba(201,168,76,0.1)",
          }}
        >
          {/* Logo */}
          <div className="age-gate__logo-wrap flex items-center justify-center mb-6">
            <img src="/logo.svg" alt="" className="age-gate__logo w-20 h-20 object-contain" />
          </div>

          <h1 className="age-gate__title brand-wordmark mb-1">Intimora</h1>
          <p className="age-gate__subtitle text-gray-500 text-xs tracking-widest uppercase mb-8">Adult Entertainment</p>

          {/* Age warning */}
          <div className="age-gate__warning flex items-center gap-2 bg-yellow-900/20 border border-yellow-800/30 rounded-xl p-4 mb-6 text-left">
            <Shield className="w-5 h-5 text-yellow-500 flex-shrink-0" />
            <p className="text-sm text-gray-300">
              This website contains{" "}
              <span className="text-yellow-400 font-semibold">explicit adult content</span> intended only for people{" "}
              <span className="text-yellow-400 font-semibold">18 years of age or older</span>. By entering, you confirm
              you are of legal age in your jurisdiction.
            </p>
          </div>

          <p className="age-gate__terms text-gray-500 text-xs mb-6 leading-relaxed">
            By clicking "I AM 18+ – ENTER", you agree to our Terms of Service and confirm you are legally permitted
            to view adult content in your country.
          </p>

          {/* Buttons */}
          <div className="flex flex-col gap-3">
            <button
              onClick={onConfirm}
              className="w-full py-4 rounded-xl font-bold text-sm tracking-widest uppercase transition-all duration-200 hover:scale-[1.02] active:scale-[0.98]"
              style={{
                background: "linear-gradient(135deg, #c9a84c, #f0d080, #c9a84c)",
                color: "#000",
                boxShadow: "0 4px 20px rgba(201,168,76,0.4)",
              }}
            >
              🔞 I AM 18+ – ENTER
            </button>
            <button
              onClick={() => setDeclined(true)}
              className="w-full py-3 rounded-xl font-medium text-sm text-gray-500 border border-gray-800 hover:border-gray-700 hover:text-gray-400 transition"
            >
              I am under 18 – Exit
            </button>
          </div>

          <p className="age-gate__privacy text-gray-700 text-xs mt-5">Adults only • Your privacy matters</p>
        </div>
      </div>
    </div>
  );
};

export default AgeGate;
