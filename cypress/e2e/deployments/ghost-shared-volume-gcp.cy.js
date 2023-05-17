import {deploymentNames, deploySharedVolume1, deploySharedVolume2} from '../../support/shared-volume'

describe('GCP shared volume', () => {
  const [dep1, dep2] = deploymentNames('Sharing', 'Borrowing')
  const fixture = 'generated/deployments/_gcp__ghost__volume.json'
  const cardTestId = 'card-google-cloud-compute-persistent-disk'

  it('Can deploy a volume (gcp)', () => {
    deploySharedVolume1(dep1, fixture, cardTestId)
  })

  it('Can share a deployed volume (gcp)', () => {
    deploySharedVolume2(dep1, dep2, fixture, cardTestId)
  })

})
