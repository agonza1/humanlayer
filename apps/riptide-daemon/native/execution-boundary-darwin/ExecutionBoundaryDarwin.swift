#if os(macOS) && arch(arm64)
import Virtualization

// A reported framework state is only one input to a future attestor. This type
// cannot express closed storage, host effects, remote jobs or a positive receipt.
enum DarwinComputeObservation: Sendable {
    case reportedStopped
    case mayExecuteOrResume
    case unavailable
}

struct DarwinStopScope: Sendable, Equatable {
    let boundaryDigest: String
    let controllerEpoch: UInt64
    let stopID: String
    let fenceSequence: UInt64
    let proofRevision: UInt64
    let challenge: String
}

@available(macOS 11.0, *)
struct DarwinFrameworkObservation: Sendable {
    let scope: DarwinStopScope
    let compute: DarwinComputeObservation

    init(scope: DarwinStopScope, state: VZVirtualMachine.State) {
        self.scope = scope
        switch state {
        case .stopped:
            compute = .reportedStopped
        case .error:
            compute = .unavailable
        default:
            compute = .mayExecuteOrResume
        }
    }
}
#else
#error("This scaffold compiles only for macOS on Apple silicon.")
#endif
